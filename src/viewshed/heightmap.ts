// Builds the elevation heightmap the WebGPU viewshed marches over (see ./gpu.ts) from the SAME surface
// the map's `terrain-dem` source draws — so the line-of-sight result always matches whatever is draped
// in the viewport. The store hands us the AWS Terrarium baseline template + the active overlays (LINZ
// when on) + the served maxzoom; we pick a zoom for the requested radius and, per covering XYZ tile,
// call composeTerrariumTileRGBA (demTiles.ts) — which fetches the baseline, overlays the higher-detail
// sources per pixel, and returns Terrarium-encoded RGBA — then blit that into one web-mercator-aligned
// RGBA8 mosaic. Terrarium decoding (height = (R*256 + G + B/256) − 32768) happens later, on the GPU.
//
// The mosaic spans whole tile edges, so its bbox corners are exact tile boundaries and it drops
// straight into a MapLibre canvas source with no reprojection: the tiles are already web-mercator,
// so rows are evenly spaced in mercator Y. (Contrast the lat-spaced SPLAT coverage GeoTIFF, which
// store.ts has to mercatorWarp before draping.)

import { composeTerrariumTileRGBA, type OverlaySpec } from '../terrain/demTiles.ts';

// Web-mercator slippy-tile math. A local copy keeps this module self-contained and free of any
// import cycle with the store, and it needs the inverse (tile→lng/lat) the store doesn't have.
const MAX_LAT = 85.05112878;
function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number): number {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

const TILE = 256;
// 8×8 cap per mosaic. getHeightmap coarsens (drops a zoom) rather than exceed it, so a big radius
// degrades to a lower-res surface instead of fetching a whole country of tiles.
const MAX_TILES = 64;
const FETCH_CONCURRENCY = 8;
// Per-tile fetch cap. A cold LINZ DEM/DSM tile is a live COG warp on the backend and can take a few
// seconds; the AWS Terrarium CDN (srtm) is fast. Without a cap, one slow/stuck backend tile leaves
// the whole compute pending forever — which freezes the viewshed (it holds viewshedComputing open),
// so it silently stops updating after switching to a LINZ source. A timed-out tile falls back to the
// sea sentinel; the next run (tiles now warm in the backend/browser cache) fills it in.
const TILE_TIMEOUT_MS = 15000;
// Minimum gap between progressive onProgress emits (each re-reads the mosaic, ~16 MB), so a slow
// LINZ fetch refines the view a few times per second rather than per-tile.
const PROGRESS_MS = 250;
const perfNow = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);
// Fetch a little beyond the requested radius so small live-drags stay inside the cached mosaic (no
// refetch). 1.6× is a comfortable margin without ballooning the tile count.
const FETCH_PAD = 1.6;
// Web-mercator ground resolution (metres per 256-px tile pixel) at the equator, zoom 0.
const EQUATOR_MPP_Z0 = 156543.03392;

export interface Heightmap {
  // Raw RGBA8 Terrarium bytes, row-major, width*height*4. Uploaded to the GPU verbatim via
  // writeTexture (no canvas round-trip), so the elevation bytes are byte-exact — no colour
  // management can shift the encoded heights. Typed over a plain ArrayBuffer (not the widened
  // ArrayBufferLike of ImageData.data) so it satisfies WebGPU's GPUAllowSharedBufferSource.
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  // Tile-edge bbox of the mosaic, degrees (north > south, east > west).
  west: number;
  north: number;
  east: number;
  south: number;
  z: number;
  // Mosaic top-left in global tile-pixel coords at zoom z (= x0*256, y0*256); lets the engine map a
  // lng/lat to a mosaic pixel.
  originX: number;
  originY: number;
  // Resolved tile-URL template + tile range; the store keys its recompute/refetch cache on this.
  sourceKey: string;
}

// Emitted (throttled) while tiles stream in, so the caller can render a partial result and show a
// loading count. `hm.data` is refreshed to the mosaic-so-far; `loaded` counts processed tiles
// (successfully drawn or failed-to-sea) out of `total`.
export interface HeightmapProgress {
  hm: Heightmap;
  loaded: number;
  total: number;
}

export interface HeightmapRequest {
  urlTemplate: string; // the AWS Terrarium baseline {z}/{x}/{y} template (composited from, not meshdem://)
  overlays: OverlaySpec[]; // higher-detail overlays composited over the baseline (LINZ when on; [] = off)
  maxzoom: number; // served cap; never request finer (overzoom past it just 404s/redirects)
  lon: number;
  lat: number;
  radiusM: number; // half-extent the viewshed will actually use
  // The map's current zoom. We fetch at the tile zoom the MAP is displaying (clamped to the served
  // band) so the viewshed requests the SAME tiles the map already loaded — served warm from the
  // backend/browser cache rather than cold-warped at some independent zoom.
  mapZoom: number;
}

// The slippy zoom the map is displaying for this source (clamped to its served band), so the
// viewshed requests the same tiles the map already loaded (a warm cache hit).
// coverTiles coarsens DOWN from here only if the radius needs more than the tile budget.
function pickZoom(req: HeightmapRequest): number {
  return Math.max(0, Math.min(req.maxzoom, Math.round(req.mapZoom)));
}

// Lng/lat → mosaic pixel (fractional). Used by the engine to place the observer.
export function lngLatToMosaicPixel(hm: Heightmap, lon: number, lat: number): [number, number] {
  return [lonToTileX(lon, hm.z) * TILE - hm.originX, latToTileY(lat, hm.z) * TILE - hm.originY];
}

// Mosaic ground resolution (metres per mosaic pixel) at a latitude.
export function mosaicMetresPerPixel(hm: Heightmap, lat: number): number {
  return (EQUATOR_MPP_Z0 * Math.max(0.01, Math.cos((lat * Math.PI) / 180))) / 2 ** hm.z;
}

// Small LRU so live-dragging within an already-fetched area never refetches. Keyed by the resolved
// template + zoom + tile range, so switching terrain source (a new template) misses → refetches.
const cache = new Map<string, Heightmap>();
const CACHE_MAX = 4;
function cacheGet(key: string): Heightmap | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // LRU bump
    cache.set(key, hit);
  }
  return hit;
}
function cachePut(key: string, hm: Heightmap): void {
  cache.set(key, hm);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

interface TileRange {
  z: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// The covering tile range for a padded square bbox at the chosen zoom, coarsened (zoom dropped)
// until it fits MAX_TILES so a large radius degrades gracefully instead of fetching the world.
function coverTiles(req: HeightmapRequest, west: number, east: number, south: number, north: number): TileRange {
  let z = pickZoom(req);
  for (;;) {
    const max = 2 ** z - 1;
    const x0 = Math.max(0, Math.floor(lonToTileX(west, z)));
    const x1 = Math.min(max, Math.floor(lonToTileX(east, z)));
    const y0 = Math.max(0, Math.floor(latToTileY(north, z))); // north edge → smaller y
    const y1 = Math.min(max, Math.floor(latToTileY(south, z)));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES || z <= 0) {
      return { z, x0, y0, x1, y1 };
    }
    z -= 1;
  }
}

export async function getHeightmap(
  req: HeightmapRequest,
  onProgress?: (p: HeightmapProgress) => void,
): Promise<Heightmap> {
  // Padded square bbox around the node (degrees).
  const r = req.radiusM * FETCH_PAD;
  const dLat = r / 111320;
  const dLon = r / (111320 * Math.max(0.01, Math.cos((req.lat * Math.PI) / 180)));
  const west = req.lon - dLon;
  const east = req.lon + dLon;
  const south = req.lat - dLat;
  const north = req.lat + dLat;

  const { z, x0, y0, x1, y1 } = coverTiles(req, west, east, south, north);
  const nx = x1 - x0 + 1;
  const ny = y1 - y0 + 1;

  // Overlay set is part of the key, so toggling LINZ on/off misses → refetches the new surface.
  const overlayKey = req.overlays.map((o) => o.urlTemplate).join(',');
  const sourceKey = `${req.urlTemplate}|${overlayKey}|${z}|${x0},${y0},${x1},${y1}`;
  const cached = cacheGet(sourceKey);
  if (cached) {
    return cached;
  }

  const canvas = document.createElement('canvas');
  canvas.width = nx * TILE;
  canvas.height = ny * TILE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Sea sentinel for any tile that fails to load (or hasn't loaded yet): Terrarium 0 m = (R128,G0,B0).
  // Pre-fill so holes read as flat sea (trivially visible, never NaN) instead of transparent gaps.
  ctx.fillStyle = 'rgb(128,0,0)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // getImageData returns the raw stored bytes (no colour conversion for an sRGB canvas drawn from
  // colorSpaceConversion:'none' bitmaps). View its buffer as a plain Uint8Array<ArrayBuffer> for the
  // GPU upload — the buffer really is an ArrayBuffer at runtime; the cast just narrows the type.
  const readBytes = (): Uint8Array<ArrayBuffer> =>
    new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer as ArrayBuffer);

  // Build the heightmap up front (sea-filled) so progressive emits can hand the caller the
  // mosaic-so-far; data is refreshed from the canvas as tiles land.
  const hm: Heightmap = {
    data: readBytes(),
    width: canvas.width,
    height: canvas.height,
    west: tileXToLon(x0, z),
    north: tileYToLat(y0, z),
    east: tileXToLon(x1 + 1, z),
    south: tileYToLat(y1 + 1, z),
    z,
    originX: x0 * TILE,
    originY: y0 * TILE,
    sourceKey,
  };

  const jobs: Array<[number, number]> = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push([x, y]);
    }
  }
  const total = jobs.length;
  let next = 0;
  let done = 0; // processed (drawn or failed-to-sea); drives the progress count
  let failed = 0;
  let lastEmit = 0;
  const emit = (force: boolean): void => {
    if (!onProgress) {
      return;
    }
    const now = perfNow();
    if (!force && now - lastEmit < PROGRESS_MS) {
      return;
    }
    lastEmit = now;
    hm.data = readBytes(); // refresh the mosaic-so-far for the caller's partial render
    onProgress({ hm, loaded: done, total });
  };
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TILE_TIMEOUT_MS);
      try {
        // composeTerrariumTileRGBA fetches the AWS baseline and overlays the active higher-detail
        // sources (LINZ when on) per pixel, returning Terrarium-encoded RGBA — the SAME surface the map
        // draws via the meshdem:// protocol. putImageData writes the bytes verbatim (no colour
        // management), so the elevation encoding stays byte-exact for the GPU decode.
        const rgba = await composeTerrariumTileRGBA(z, x, y, req.urlTemplate, req.overlays, ctrl.signal);
        if (rgba) {
          ctx.putImageData(new ImageData(rgba, TILE, TILE), (x - x0) * TILE, (y - y0) * TILE);
        } else {
          failed++; // nothing fetched: leave the sea sentinel for this cell
        }
      } catch {
        failed++; // network/decode failure or timeout: keep the sea sentinel
      } finally {
        clearTimeout(timer);
      }
      done++;
      emit(false);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, jobs.length) }, worker));
  if (failed) {
    // A warn (not a throw) so the compute still completes and renders: diagnosable without freezing.
    console.warn(
      `viewshed: ${failed}/${total} terrain tiles failed or timed out at z${z} (filled as sea). ` +
        `Cold LINZ elevation tiles are a live COG render and can be slow on first request; ` +
        `pan/zoom over the area once to warm them, then recompute.`,
    );
  }

  hm.data = readBytes(); // final, complete mosaic
  cachePut(sourceKey, hm);
  return hm;
}
