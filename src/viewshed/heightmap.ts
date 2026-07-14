// Builds the elevation heightmap the WebGPU viewshed marches over (see ./gpu.ts) from the SAME surface
// the map's `terrain-dem` source draws — so the line-of-sight result always matches whatever is draped
// in the viewport. The store hands us the Mapterhorn baseline template + the active overlays (LINZ
// when on) + the served maxzoom; we pick a zoom for the requested radius and, per covering XYZ tile,
// call composeTerrariumTileRGBA (demTiles.ts) — which fetches the baseline, overlays the higher-detail
// sources per pixel, and returns Terrarium-encoded RGBA — then blit that into one web-mercator-aligned
// RGBA8 mosaic. Terrarium decoding (height = (R*256 + G + B/256) − 32768) happens later, on the GPU.
//
// The mosaic spans whole tile edges, so its bbox corners are exact tile boundaries and it drops
// straight into a MapLibre canvas source with no reprojection: the tiles are already web-mercator,
// so rows are evenly spaced in mercator Y. (Contrast the lat-spaced coverage grid, which store.ts
// has to mercatorWarp before draping.)

import { composeTerrariumTileRGBACached, type OverlaySpec } from '../terrain/demTiles.ts';

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
// seconds. Without a cap, one slow/stuck tile leaves the whole compute pending forever — which freezes
// the viewshed (it holds viewshedComputing open). A timed-out tile falls back to the sea sentinel; the
// next run (tiles now warm in the backend/browser cache) fills it in.
const TILE_TIMEOUT_MS = 25000;
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
  urlTemplate: string; // the Mapterhorn baseline {z}/{x}/{y} template (composited from, not meshdem://)
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

// Shared by every viewshed compute engine (gpu.ts, webgl2.ts): places the observer in output-pixel
// space and derives the output→mosaic scale + ground resolution, so each engine just plugs these into
// its own Params/uniform upload instead of re-deriving the same mosaic geometry per backend.
export interface ViewshedOutputGeometry {
  obsOutX: number;
  obsOutY: number;
  outToMosaicX: number;
  outToMosaicY: number;
  mppOut: number; // metres per OUTPUT pixel (horizontal), ≈ vertical too since pixels are ~square
}

export function viewshedOutputGeometry(
  hm: Heightmap,
  obsLon: number,
  obsLat: number,
  outW: number,
  outH: number,
): ViewshedOutputGeometry {
  const [mx, my] = lngLatToMosaicPixel(hm, obsLon, obsLat);
  const outToMosaicX = hm.width / outW;
  const outToMosaicY = hm.height / outH;
  return {
    obsOutX: mx / outToMosaicX,
    obsOutY: my / outToMosaicY,
    outToMosaicX,
    outToMosaicY,
    mppOut: mosaicMetresPerPixel(hm, obsLat) * outToMosaicX,
  };
}

// Small LRU so live-dragging within an already-fetched area never refetches. Keyed by the resolved
// template + zoom + tile range, so switching terrain source (a new template) misses → refetches.
// Sized for a coverage LOD stack (up to LOD_MAX_LEVELS concentric mosaics) plus the matrix/relay
// square coexisting without thrashing — each level keys independently, so re-runs reuse warm rings.
const cache = new Map<string, Heightmap>();
const CACHE_MAX = 12;
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

// Padded square bbox (degrees) around a centre: half-extent radiusM widened by FETCH_PAD, with the
// longitude span growing toward the poles (the cos floor keeps the divisor finite). Shared by
// getHeightmap and heightmapTileCount so a planned tile count always matches the actual fetch.
function coverBbox(
  lon: number,
  lat: number,
  radiusM: number,
): { west: number; east: number; south: number; north: number } {
  const r = radiusM * FETCH_PAD;
  const dLat = r / 111320;
  const dLon = r / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
}

export async function getHeightmap(
  req: HeightmapRequest,
  onProgress?: (p: HeightmapProgress) => void,
): Promise<Heightmap> {
  // Padded square bbox around the node (degrees).
  const { west, east, south, north } = coverBbox(req.lon, req.lat, req.radiusM);

  const { z, x0, y0, x1, y1 } = coverTiles(req, west, east, south, north);
  const nx = x1 - x0 + 1;
  const ny = y1 - y0 + 1;

  // Overlay set is part of the key, so toggling LINZ on/off misses → refetches the new surface.
  // rasterize-based overlays (e.g. buildings) have no urlTemplate; id stands in for it.
  const overlayKey = req.overlays.map((o) => o.id ?? o.urlTemplate).join(',');
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
        // composeTerrariumTileRGBACached fetches the Mapterhorn baseline and overlays the active higher-detail
        // sources (LINZ when on) per pixel, returning Terrarium-encoded RGBA — the SAME surface, drawn
        // from the SAME shared composited-tile cache, the map draws via the meshdem:// protocol, so this
        // fetch also warms the 3D terrain. putImageData writes the bytes verbatim (no colour management),
        // so the elevation encoding stays byte-exact for the GPU decode.
        const rgba = await composeTerrariumTileRGBACached(z, x, y, req.urlTemplate, req.overlays, ctrl.signal);
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

// ── Corridor fetch (profile-only) ────────────────────────────────────────────────────────────────
// The terrain profile reads a 1-D line across the square mosaic, yet getHeightmap fetches a whole
// square and coarsens its zoom once a long link's square blows past MAX_TILES — flattening the very
// ridges the profile cares about. The corridor path instead fetches ONLY the tiles the great-circle
// line crosses (plus a 1-ring margin for bilinear neighbours), which grows linearly with length, so a
// long link stays at full z15. The sampling happens on the main thread (sampleProfileCorridor in
// profile.ts) and only the resulting ProfileSample crosses to the worker — the shared square Heightmap
// path is untouched.

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_M = 6371000.0; // matches the curvature constant used across the sim

// Local copies of the two great-circle helpers profile.ts also defines. profile.ts imports from this
// module, so importing them back the other way would close an import cycle; a local copy (like the
// slippy math above) keeps this file self-contained.
function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = lat1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD;
  const dφ = (lat2 - lat1) * DEG2RAD;
  const dλ = (lon2 - lon1) * DEG2RAD;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
function interpGreatCircle(lon1: number, lat1: number, lon2: number, lat2: number, f: number): [number, number] {
  const φ1 = lat1 * DEG2RAD,
    λ1 = lon1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD,
    λ2 = lon2 * DEG2RAD;
  const dφ = φ2 - φ1,
    dλ = λ2 - λ1;
  const hav = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const δ = 2 * Math.asin(Math.min(1, Math.sqrt(hav)));
  if (δ < 1e-9) {
    return [lon1, lat1];
  }
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  const φ = Math.atan2(z, Math.hypot(x, y));
  const λ = Math.atan2(y, x);
  return [λ * RAD2DEG, φ * RAD2DEG];
}

// Tile budget for the corridor (vs the square's MAX_TILES=64). At z15 a corridor stays full-detail up
// to ~60 km before dropping one zoom; even coarsened it's 4× finer than the square path today. Tunable.
const CORRIDOR_BUDGET = 192;

export interface CorridorRequest {
  urlTemplate: string; // the Mapterhorn baseline {z}/{x}/{y} template (composited from, not meshdem://)
  overlays: OverlaySpec[]; // higher-detail overlays composited over the baseline (LINZ when on; [] = off)
  maxzoom: number; // served cap; never request finer (overzoom past it just 404s/redirects)
  txLon: number;
  txLat: number;
  rxLon: number;
  rxLat: number;
}

// The sparse tiles a corridor fetch produced: a zoom and the composited Terrarium RGBA per covered
// tile, keyed "x,y". A missing key reads as the 0 m sea sentinel (the square pre-fills rgb(128,0,0)
// for the same reason), so a failed/timed-out tile is flat sea, never NaN.
export interface CorridorTiles {
  z: number;
  tiles: Map<string, Uint8ClampedArray>;
}

// The tiles the TX->RX great circle crosses at zoom z, dilated by a 1-ring (Moore) margin so bilinear
// sampling at any tile edge still has all four neighbour texels present.
function corridorTiles(txLon: number, txLat: number, rxLon: number, rxLat: number, z: number): Set<string> {
  const distanceM = haversineM(txLon, txLat, rxLon, rxLat);
  const midLat = (txLat + rxLat) / 2;
  const tileM = (EQUATOR_MPP_Z0 * TILE * Math.max(0.01, Math.cos(midLat * DEG2RAD))) / 2 ** z;
  const steps = Math.max(1, Math.ceil((distanceM / tileM) * 4)); // ≈¼-tile walk so no crossing is skipped
  const max = 2 ** z - 1;
  const core = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const [lon, lat] = interpGreatCircle(txLon, txLat, rxLon, rxLat, i / steps);
    const tx = Math.floor(lonToTileX(lon, z));
    const ty = Math.floor(latToTileY(lat, z));
    core.add(`${tx},${ty}`);
  }
  // Dilate by the 1-ring so the bilinear sampler's four neighbours always exist (avoids edge holes).
  const out = new Set<string>();
  for (const key of core) {
    const [cx, cy] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x <= max && y >= 0 && y <= max) {
          out.add(`${x},${y}`);
        }
      }
    }
  }
  return out;
}

// Pick the corridor zoom: start at the served maxzoom and drop a zoom (recomputing the set) whenever
// it exceeds CORRIDOR_BUDGET, so a very long link degrades gracefully — mirrors coverTiles for the
// square. Returns the chosen zoom and its dilated tile set.
function corridorTilesCapped(req: CorridorRequest): { z: number; tiles: Set<string> } {
  let z = Math.max(0, req.maxzoom);
  for (;;) {
    const tiles = corridorTiles(req.txLon, req.txLat, req.rxLon, req.rxLat, z);
    if (tiles.size <= CORRIDOR_BUDGET || z <= 0) {
      return { z, tiles };
    }
    z -= 1;
  }
}

// Fetch the corridor's tiles via the same bounded pool as getHeightmap (FETCH_CONCURRENCY workers, a
// per-tile AbortController+TILE_TIMEOUT_MS, throttled onProgress + forced final emit, a failed counter
// and one console.warn). Unlike getHeightmap this threads the outer `signal`, so a superseded profile
// actually stops fetching mid-flight rather than running every tile to completion.
export async function getCorridor(
  req: CorridorRequest,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<CorridorTiles> {
  const { z, tiles: keys } = corridorTilesCapped(req);

  const jobs = Array.from(keys, (key) => {
    const [x, y] = key.split(',').map(Number);
    return [x, y] as [number, number];
  });
  const tiles = new Map<string, Uint8ClampedArray>();
  const total = jobs.length;
  let next = 0;
  let done = 0;
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
    onProgress(done, total);
  };
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      // Chain the per-tile timeout to the outer signal so a cancelled profile aborts in-flight fetches.
      const ctrl = new AbortController();
      const onAbort = (): void => ctrl.abort();
      signal?.addEventListener('abort', onAbort);
      const timer = setTimeout(() => ctrl.abort(), TILE_TIMEOUT_MS);
      try {
        // composeTerrariumTileRGBACached shares one composited-tile cache with getHeightmap and the map's
        // meshdem:// handler: a hit returns instantly (a superseded profile still gets warm tiles), and
        // this fetch warms the map's 3D terrain in turn.
        const rgba = await composeTerrariumTileRGBACached(z, x, y, req.urlTemplate, req.overlays, ctrl.signal);
        if (rgba) {
          tiles.set(`${x},${y}`, rgba);
        } else {
          failed++; // nothing fetched: absent key reads as the 0 m sea sentinel
        }
      } catch {
        failed++; // network/decode failure, timeout, or outer abort: absent key reads as sea
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      done++;
      emit(false);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, jobs.length) }, worker));
  if (failed) {
    console.warn(
      `profile: ${failed}/${total} corridor terrain tiles failed or timed out at z${z} (read as sea). ` +
        `Cold LINZ elevation tiles are a live COG render and can be slow on first request; ` +
        `pan/zoom over the area once to warm them, then recompute.`,
    );
  }
  emit(true);
  return { z, tiles };
}

// Decode one Terrarium texel of a sparse corridor tile to metres: h = (R*256 + G + B/256) - 32768.
// A missing tile (or an out-of-tile index) is the 0 m sea sentinel — identical to the square's fill.
function decodeCorridorTexel(c: CorridorTiles, gx: number, gy: number): number {
  const tx = Math.floor(gx / TILE);
  const ty = Math.floor(gy / TILE);
  const tile = c.tiles.get(`${tx},${ty}`);
  if (!tile) {
    return 0;
  }
  const px = gx - tx * TILE;
  const py = gy - ty * TILE;
  const i = (py * TILE + px) * 4;
  return tile[i] * 256 + tile[i + 1] + tile[i + 2] / 256 - 32768;
}

// Bilinearly sample the corridor (m ASL) at a lon/lat, using the SAME half-pixel offsets as
// sampleHeightAt but in GLOBAL tile-pixel coords (so a texel resolves into whichever sparse tile holds
// it). Algebraically equals sampleHeightAt for the same bytes, so short links agree to floating point.
export function sampleCorridorHeightAt(c: CorridorTiles, lon: number, lat: number): number {
  const gx = lonToTileX(lon, c.z) * TILE;
  const gy = latToTileY(lat, c.z) * TILE;
  const x0 = Math.floor(gx - 0.5);
  const y0 = Math.floor(gy - 0.5);
  const fx = gx - 0.5 - x0;
  const fy = gy - 0.5 - y0;
  const h00 = decodeCorridorTexel(c, x0, y0);
  const h10 = decodeCorridorTexel(c, x0 + 1, y0);
  const h01 = decodeCorridorTexel(c, x0, y0 + 1);
  const h11 = decodeCorridorTexel(c, x0 + 1, y0 + 1);
  const top = h00 + (h10 - h00) * fx;
  const bot = h01 + (h11 - h01) * fx;
  return top + (bot - top) * fy;
}

// Corridor ground resolution (metres per tile pixel) at a latitude — the default profile spacing when
// sampling a corridor, mirroring mosaicMetresPerPixel for the square.
export function corridorMetresPerPixel(c: CorridorTiles, lat: number): number {
  return (EQUATOR_MPP_Z0 * Math.max(0.01, Math.cos(lat * DEG2RAD))) / 2 ** c.z;
}

// ── Concentric LOD fetch (coverage-only) ───────────────────────────────────────────────────────────
// The coverage radial sweep's effective ground resolution FALLS with distance from the TX: adjacent
// rays diverge, so the cross-ray arc (≈ d·2π/azimuths) grows with distance d. A single uniform-zoom
// square (getHeightmap) therefore either wastes tiles at the rim or — as it did — coarsens the WHOLE
// disc to fit MAX_TILES, flattening the terrain near the TX where the sweep is densest and tied to the
// map's current zoom besides. getLodHeightmap instead fetches a STACK of square mosaics centred on the
// TX: the innermost at the served maxzoom over a small disc, each outer ring doubling its radius and
// dropping one zoom (so tiles-per-level stays ≈ constant). sampleLodHeightAt (profile.ts) reads each
// sample from the finest level whose data reaches it. Every level is a plain Heightmap fetched by
// getHeightmap, so all the tile fetch/composite/cache machinery is reused unchanged.

const LOD_BASE_RING_M = 4000; // innermost disc radius, fetched at maxzoom; ≤ this radius ⇒ one z-max mosaic
const LOD_RING_GROWTH = 2; // each outer ring doubles its radius and drops one zoom (≈ constant tiles/level)
const LOD_MIN_Z = 8; // never coarsen a ring below this
const LOD_MAX_LEVELS = 6; // bound the stack (6 levels reach a 100 km radius from z15)

export interface LodLevel {
  hm: Heightmap;
  innerRadiusM: number; // largest TX-centred disc fully inside this level's mosaic — its trusted extent
}

// A finest-first stack of concentric Heightmaps for one coverage disc. levels[0] is the highest-zoom
// inner mosaic; the sampler walks outward to the first level whose innerRadiusM reaches the sample.
export interface LodHeightmap {
  levels: LodLevel[];
  lon: number;
  lat: number;
}

// A coverage LOD request: a HeightmapRequest WITHOUT mapZoom — decoupling the terrain zoom from the
// map's is the whole point, so each ring's zoom comes from the ladder instead.
export interface LodRequest {
  urlTemplate: string;
  overlays: OverlaySpec[];
  maxzoom: number;
  lon: number;
  lat: number;
  radiusM: number;
}

// The (zoom, radius) rungs of the LOD stack, finest first: start at maxzoom over LOD_BASE_RING_M and
// double the radius / drop a zoom until the rings reach radiusM (or the bounds run out); the outermost
// rung is stretched to radiusM so the whole disc is always covered.
export function buildLodLadder(maxzoom: number, radiusM: number): Array<{ z: number; rM: number }> {
  let z = Math.max(0, maxzoom);
  let rM = Math.min(radiusM, LOD_BASE_RING_M);
  const rungs = [{ z, rM }];
  while (rM < radiusM && z > LOD_MIN_Z && rungs.length < LOD_MAX_LEVELS) {
    z -= 1;
    rM = Math.min(radiusM, rM * LOD_RING_GROWTH);
    rungs.push({ z, rM });
  }
  const last = rungs[rungs.length - 1];
  if (last.rM < radiusM) {
    last.rM = radiusM; // outermost ring reaches the rim even if the bounds capped the ladder early
  }
  return rungs;
}

// The number of tiles getHeightmap WOULD fetch for a request — bbox + coverTiles, exactly as the fetch
// computes it (no duplicated math), so the LOD progress denominator matches the tiles that actually land.
function heightmapTileCount(req: HeightmapRequest): number {
  const { west, east, south, north } = coverBbox(req.lon, req.lat, req.radiusM);
  const { x0, y0, x1, y1 } = coverTiles(req, west, east, south, north);
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

// The largest TX-centred disc fully inside a fetched mosaic (metres) — its trustworthy sampling extent.
// The mosaic is tile-edge aligned, so the TX isn't exactly centred; take the min half-span to the four
// edges so a sample within it never reads past the level's real data into the sea-sentinel border.
function inscribedRadiusM(hm: Heightmap, lon: number, lat: number): number {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.max(0.01, Math.cos(lat * DEG2RAD));
  return Math.min(
    (hm.east - lon) * mPerDegLon,
    (lon - hm.west) * mPerDegLon,
    (hm.north - lat) * mPerDegLat,
    (lat - hm.south) * mPerDegLat,
  );
}

// Fetch the concentric LOD stack for a coverage disc. Each rung is a normal getHeightmap call with
// mapZoom pinned to the rung's zoom (pickZoom = min(maxzoom, round(mapZoom)), and the rung's z ≤ maxzoom,
// so this yields exactly z; coverTiles may coarsen a big rung further, which only helps). Rungs fetch
// finest-first and sequentially so the inner detail lands first; progress sums across the whole stack
// (the per-rung count is deterministic, so "loaded/total" reads as whole tiles and the fraction is
// monotonic with a fixed denominator).
export async function getLodHeightmap(
  req: LodRequest,
  onProgress?: (loaded: number, total: number) => void,
): Promise<LodHeightmap> {
  const reqs: HeightmapRequest[] = buildLodLadder(req.maxzoom, req.radiusM).map((rung) => ({
    urlTemplate: req.urlTemplate,
    overlays: req.overlays,
    maxzoom: req.maxzoom,
    lon: req.lon,
    lat: req.lat,
    radiusM: rung.rM,
    mapZoom: rung.z,
  }));
  const counts = reqs.map(heightmapTileCount);
  const grandTotal = counts.reduce((sum, n) => sum + n, 0);

  const levels: LodLevel[] = [];
  let loadedBase = 0;
  for (let k = 0; k < reqs.length; k++) {
    const hm = await getHeightmap(
      reqs[k],
      onProgress ? (p) => onProgress(loadedBase + p.loaded, grandTotal) : undefined,
    );
    loadedBase += counts[k];
    levels.push({ hm, innerRadiusM: inscribedRadiusM(hm, req.lon, req.lat) });
  }
  onProgress?.(grandTotal, grandTotal); // getHeightmap has no forced final emit; finish the terrain bar
  return { levels, lon: req.lon, lat: req.lat };
}
