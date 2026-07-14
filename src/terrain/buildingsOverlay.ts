// Bakes OpenStreetMap building footprint heights into the shared Terrarium elevation surface (see
// demTiles.ts), so every consumer of that surface — 3D terrain, hillshade, link profile, coverage,
// relay, and the viewshed — treats buildings as obstructions, worldwide, without any of them needing
// their own vector-geometry code. Registered as the 'builtin-osm-buildings' DemProvider's `rasterize`
// (demTiles.ts), which composeTerrariumTileRGBA calls instead of fetching a raster tile.
//
// Buildings come from OpenFreeMap vector tiles (OpenMapTiles schema, 'building' source-layer,
// render_height in metres) — the same source the visual 3D-buildings map layer uses (store.ts). Vector
// tiles cap at z14 while the DEM grid goes to z15 (DEM_MAXZOOM), so at z15 we crop+scale the relevant
// quadrant of the z14 parent tile rather than fetching a nonexistent z15 vector tile (standard
// overzoom).
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { TILE, type RgbaBytes, decodeTerrarium, encodeTerrarium } from './demTiles.ts';

// OpenFreeMap's actual tile path is dated/versioned (e.g. .../planet/20260607_080001_pt/{z}/{x}/{y}.pbf)
// and rotates on their periodic planet rebuilds, so the template is resolved from the TileJSON once and
// cached, rather than hardcoded.
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const BUILDING_MAXZOOM = 14; // OpenFreeMap planet TileJSON's maxzoom
const DEFAULT_HEIGHT_M = 6; // matches the visual buildings-3d layer's own fallback (store.ts)

let tileTemplatePromise: Promise<string> | null = null;
function getTileTemplate(): Promise<string> {
  if (!tileTemplatePromise) {
    tileTemplatePromise = fetch(TILEJSON_URL)
      .then((res) => res.json())
      .then((json) => json.tiles[0] as string)
      .catch((err) => {
        tileTemplatePromise = null; // let a later call retry instead of caching a permanent failure
        throw err;
      });
  }
  return tileTemplatePromise;
}

// Parsed vector tiles, keyed by their own z/x/y (not the DEM tile's) — a single z14 tile backs up to 4
// overzoomed z15 DEM tiles, so this avoids re-fetching/re-parsing it for each. The final composited
// output per DEM tile is already cached by demTiles.ts's compositeCache, so no second cache is needed
// for that.
const VT_CACHE_MAX = 64;
const vtCache = new Map<string, VectorTile | null>();
async function fetchBuildingVT(vz: number, vx: number, vy: number, signal?: AbortSignal): Promise<VectorTile | null> {
  const key = `${vz}/${vx}/${vy}`;
  const cached = vtCache.get(key);
  if (cached !== undefined) {
    vtCache.delete(key); // LRU bump
    vtCache.set(key, cached);
    return cached;
  }
  const tpl = await getTileTemplate();
  const url = tpl.replace('{z}', String(vz)).replace('{x}', String(vx)).replace('{y}', String(vy));
  const res = await fetch(url, { signal });
  const vt = res.ok ? new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer()))) : null;
  vtCache.set(key, vt);
  if (vtCache.size > VT_CACHE_MAX) {
    const oldestKey = vtCache.keys().next().value;
    if (oldestKey !== undefined) vtCache.delete(oldestKey);
  }
  return vt;
}

// One reused scratch canvas for polygon-coverage rasterization (see rasterizeBuildingsTile). Safe to
// share at module scope: everything that touches it runs in a single synchronous stretch with no
// `await` in between, so two calls can never interleave on it.
let scratch: OffscreenCanvas | null = null;
function scratchCtx(): OffscreenCanvasRenderingContext2D | null {
  if (!scratch) scratch = new OffscreenCanvas(TILE, TILE);
  // willReadFrequently: this canvas is read back with getImageData many times per tile (once per
  // building), not drawn to the screen — steers the browser to a read-optimised backing store.
  return scratch.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
}

export async function rasterizeBuildingsTile(
  z: number,
  x: number,
  y: number,
  base: RgbaBytes | null,
  signal?: AbortSignal,
): Promise<RgbaBytes | null> {
  try {
    const vz = Math.min(z, BUILDING_MAXZOOM);
    const shift = z - vz;
    const vx = x >> shift;
    const vy = y >> shift;
    const vt = await fetchBuildingVT(vz, vx, vy, signal);
    const layer = vt?.layers['building'];
    if (!layer || layer.length === 0) return null;

    // Quadrant of the (possibly overzoomed) parent vector tile this DEM tile occupies, in canvas-pixel
    // units — applied by hand below (rather than ctx.setTransform) so a feature's bbox can be computed
    // in the same pass as building its path.
    const qx = x - (vx << shift);
    const qy = y - (vy << shift);
    const scale = (TILE * (1 << shift)) / layer.extent;
    const tx = -qx * TILE;
    const ty = -qy * TILE;

    const feats: { height: number; rings: { x: number; y: number }[][] }[] = [];
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.properties.hide_3d) continue; // OpenMapTiles flag: not meant to be extruded
      const rh = f.properties.render_height;
      feats.push({ height: typeof rh === 'number' ? rh : DEFAULT_HEIGHT_M, rings: f.loadGeometry() });
    }
    if (feats.length === 0) return null;
    feats.sort((a, b) => a.height - b.height); // taller buildings win overlapping pixels

    const ctx = scratchCtx();
    if (!ctx) return null;
    const out = new Uint8ClampedArray(TILE * TILE * 4) as RgbaBytes;
    let any = false;

    // Per feature: rasterize ONLY its footprint's coverage (plain opaque white — no data is ever
    // encoded in the fill colour, only in the alpha channel via anti-aliased coverage), read back just
    // its bounding box, then write groundHeight + this feature's real height (a plain number, never
    // round-tripped through a canvas colour) straight into the output buffer. This sidesteps relying on
    // canvas fillStyle/getImageData to preserve exact byte values for arbitrary colours — the same class
    // of pitfall demTiles.ts's fetchTileRGBA already guards against for image decoding.
    for (const f of feats) {
      const path = new Path2D();
      let minPx = Infinity;
      let minPy = Infinity;
      let maxPx = -Infinity;
      let maxPy = -Infinity;
      for (const ring of f.rings) {
        ring.forEach((pt, idx) => {
          const px = pt.x * scale + tx;
          const py = pt.y * scale + ty;
          if (px < minPx) minPx = px;
          if (px > maxPx) maxPx = px;
          if (py < minPy) minPy = py;
          if (py > maxPy) maxPy = py;
          if (idx === 0) path.moveTo(px, py);
          else path.lineTo(px, py);
        });
        path.closePath();
      }
      const bx0 = Math.max(0, Math.floor(minPx));
      const by0 = Math.max(0, Math.floor(minPy));
      const bx1 = Math.min(TILE, Math.ceil(maxPx));
      const by1 = Math.min(TILE, Math.ceil(maxPy));
      const bw = bx1 - bx0;
      const bh = by1 - by0;
      if (bw <= 0 || bh <= 0) continue; // footprint falls entirely outside this tile

      ctx.clearRect(bx0, by0, bw, bh);
      ctx.fillStyle = '#fff';
      // evenodd correctly punches holes regardless of ring winding, per the MVT spec's ring nesting.
      ctx.fill(path, 'evenodd');

      const coverage = ctx.getImageData(bx0, by0, bw, bh).data;
      for (let py = 0; py < bh; py++) {
        for (let px = 0; px < bw; px++) {
          const ci = (py * bw + px) * 4;
          if (coverage[ci + 3] < 128) continue; // not covered by this building
          const gx = bx0 + px;
          const gy = by0 + py;
          const oi = (gy * TILE + gx) * 4;
          const groundH = base ? decodeTerrarium(base[oi], base[oi + 1], base[oi + 2]) : 0;
          encodeTerrarium(groundH + f.height, out, oi);
          out[oi + 3] = 255;
          any = true;
        }
      }
    }

    return any ? out : null;
  } catch {
    return null; // network error / abort / bad tile — same no-data convention as fetchTileRGBA
  }
}
