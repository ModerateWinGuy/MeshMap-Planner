// Browser-only DEM tile compositor. The app's terrain (3D mesh, hillshade) AND the client-side RF
// sim/viewshed all read ONE raster-dem surface; this module produces it. The global baseline is AWS
// Terrarium (free, whole-world, no key, Terrarium-encoded). On top of it we can layer any number of
// higher-detail overlay providers *where they have data* — built-in (LINZ Basemaps elevation, NZ 1 m
// LIDAR) or user-added in Settings. Each overlay marks out-of-coverage pixels as transparent (alpha 0)
// or is treated as no-data if it 404s; the composite is normalised to Terrarium encoding so every
// downstream decoder (the GPU viewshed shader, profile.ts) is unchanged regardless of how many or which
// overlays are active.
//
// Two consumers share the surface, both through `composeTerrariumTileRGBACached`:
//   - the map, via `registerDemProtocol` (MapLibre addProtocol → re-encodes the RGBA to a PNG); and
//   - the sim/viewshed, via heightmap.ts (writes the RGBA straight into its mosaic, no PNG round-trip).
// They fetch the same underlying AWS/LINZ URLs (so the browser HTTP cache is shared) AND go through the
// same composited-tile cache here — so a sim run leaves the map's 3D terrain warm, and a map pan warms
// the sim, with neither side redoing the other's per-pixel composite.

// AWS Terrarium — the global bare-earth baseline. Already carries LINZ 8 m DEM over NZ + 30 m SRTM
// elsewhere. This is also the exact URL the map uses directly when the overlay is OFF, so toggling the
// overlay reuses these tiles warm from the HTTP cache.
export const AWS_TERRARIUM_TEMPLATE =
  'https://elevation-tiles-prod.s3.amazonaws.com/v2/terrarium/{z}/{x}/{y}.png';

// LINZ Basemaps national 1 m LIDAR elevation, rendered live to Mapbox terrain-RGB PNGs.
// `pipeline=terrain-rgb` selects the Mapbox encoding; out-of-coverage pixels come back transparent
// (alpha 0), which is how we detect where to fall through to the AWS baseline. Two tilesets:
// `elevation` = DEM (bare earth) and `elevation-dsm` = DSM (surface — buildings, vegetation). Needs a
// free, non-expiring LINZ Developer API key (email basemaps@linz.govt.nz) in VITE_LINZ_API_KEY — public by
// design. Empty key just means LINZ fetches fail and the overlay degrades to the AWS baseline.
const VITE_LINZ_API_KEY = import.meta.env.VITE_LINZ_API_KEY ?? '';
function linzTemplate(tileset: string): string {
  return `https://basemaps.linz.govt.nz/v1/tiles/${tileset}/WebMercatorQuad/{z}/{x}/{y}.png?pipeline=terrain-rgb&api=${VITE_LINZ_API_KEY}`;
}
export const LINZ_DEM_TEMPLATE = linzTemplate('elevation');
export const LINZ_DSM_TEMPLATE = linzTemplate('elevation-dsm');

// Capped at z14 (~7 m/px at NZ latitude, ≈ AWS's 8 m NZ data) on purpose: the win here is COMPLETENESS
// (Terrarium renders real hills flat), not resolution. z14 is the cheapest deepest level that still
// fixes the flatness; z15+ views overzoom the z14 composite (the LINZ correction still shows). It also
// bounds the per-tile decode/composite/re-encode cost. AWS NZ data is only 8 m, so no real detail is
// lost by not fetching z15.
export const DEM_MAXZOOM = 14;

// Custom MapLibre protocol scheme for the composited terrain source (used only when an overlay is on).
export const DEM_SCHEME = 'meshdem';

// A terrain source/overlay and how its PNG bytes decode to metres. LINZ is 'mapbox'; the AWS baseline
// is 'terrarium' (kept as-is, never re-encoded). A future overlay just needs its template + encoding.
export interface OverlaySpec {
  urlTemplate: string; // a {z}/{x}/{y} template
  encoding: 'mapbox' | 'terrarium';
}

// One DEM/DSM overlay provider, built-in or user-added — the store's persisted, UI-facing shape.
// `enabledOverlaySpecs` strips it down to the OverlaySpec the compositor actually needs.
export interface DemProvider {
  id: string;
  name: string;
  urlTemplate: string; // a {z}/{x}/{y} template; any API key is embedded in it by whoever added it
  encoding: 'mapbox' | 'terrarium';
  enabled: boolean;
  builtin?: boolean; // true for LINZ rows: not editable/deletable in the UI, only toggleable
}

// Enabled providers, in list order, as the OverlaySpec[] the compositor already accepts. Composited
// top-down (see composeTerrariumTileRGBA), so later entries win where they overlap.
export function enabledOverlaySpecs(providers: DemProvider[]): OverlaySpec[] {
  return providers.filter((p) => p.enabled).map((p) => ({ urlTemplate: p.urlTemplate, encoding: p.encoding }));
}

// The built-in LINZ rows. Always re-evaluated (never frozen into the store's persisted list) so a
// future API key rotation or template fix here takes effect immediately for existing users. To add
// another region's provider permanently for everyone, add an entry here and open a PR rather than
// asking users to add it themselves.
export function builtinDemProviders(): DemProvider[] {
  return [
    { id: 'builtin-linz-dem', name: 'LINZ DEM — bare earth (NZ)', urlTemplate: LINZ_DEM_TEMPLATE, encoding: 'mapbox', enabled: false, builtin: true },
    { id: 'builtin-linz-dsm', name: 'LINZ DSM — surface, incl. buildings (NZ)', urlTemplate: LINZ_DSM_TEMPLATE, encoding: 'mapbox', enabled: false, builtin: true },
  ];
}

const TILE = 256;
const TILE_BYTES = TILE * TILE * 4;

// RGBA backed by a plain ArrayBuffer (not the widened ArrayBufferLike of ImageData.data), so it
// satisfies the ImageData constructor and heightmap.ts's GPU upload. The buffer really is an
// ArrayBuffer at runtime; the cast just narrows the type (same pattern as heightmap.ts).
type RgbaBytes = Uint8ClampedArray<ArrayBuffer>;

// Mapbox terrain-RGB (LINZ): metres above sea level.
function decodeMapbox(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}
// Terrarium: metres above sea level.
function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}
// Metres → Terrarium RGB (the unified output encoding). The sea sentinel rgb(128,0,0) is exactly
// encodeTerrarium(0), matching heightmap.ts's pre-fill.
function encodeTerrarium(h: number, out: Uint8ClampedArray, i: number): void {
  // Clamp to the representable band so a wild decode can't wrap the channels.
  const v = Math.max(0, Math.min(65535.99609375, h + 32768));
  const r = Math.floor(v / 256);
  const rem = v - r * 256;
  const g = Math.floor(rem);
  let b = Math.round((rem - g) * 256);
  if (b === 256) b = 255; // carry guard; the 1/256 m it drops is negligible
  out[i] = r;
  out[i + 1] = g;
  out[i + 2] = b;
  out[i + 3] = 255;
}

// Fetch one tile and return its raw RGBA bytes (256×256×4), or null on 404 / network error / abort.
// colorSpaceConversion:'none' + premultiplyAlpha:'none' keep the elevation-encoded bytes (and LINZ's
// nodata alpha) byte-exact — no gamma/ICC shift, no alpha pre-multiply zeroing the RGB.
async function fetchTileRGBA(url: string, signal?: AbortSignal): Promise<RgbaBytes | null> {
  let res: Response;
  try {
    res = await fetch(url, { mode: 'cors', signal });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const bmp = await createImageBitmap(await res.blob(), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    const cv = new OffscreenCanvas(TILE, TILE);
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(bmp, 0, 0);
    bmp.close();
    // getImageData's buffer is a full TILE×TILE×4 ArrayBuffer at offset 0; re-view it as ArrayBuffer.
    return new Uint8ClampedArray(cx.getImageData(0, 0, TILE, TILE).data.buffer as ArrayBuffer);
  } catch {
    return null;
  }
}

function tileUrl(tpl: string, z: number, x: number, y: number): string {
  return tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

// Compose one tile: AWS Terrarium baseline, with each overlay (top-down) overwriting the pixels where
// it has valid data, re-encoded to Terrarium. Returns 256×256×4 Terrarium RGBA, or null if nothing
// could be fetched (caller keeps its sea sentinel). An overlay marks no-data as transparent (alpha 0,
// per LINZ), so alpha is the coverage mask.
export async function composeTerrariumTileRGBA(
  z: number,
  x: number,
  y: number,
  baseTemplate: string,
  overlays: OverlaySpec[],
  signal?: AbortSignal,
): Promise<RgbaBytes | null> {
  const base = await fetchTileRGBA(tileUrl(baseTemplate, z, x, y), signal);

  if (overlays.length === 0) return base; // overlay off: baseline as-is (or null → caller sentinels)

  // Start from the baseline (kept byte-exact, it's already Terrarium); sea sentinel if the base failed.
  const out: RgbaBytes = base ?? new Uint8ClampedArray(TILE_BYTES);
  if (!base) for (let i = 0; i < TILE_BYTES; i += 4) encodeTerrarium(0, out, i);
  let anyData = base != null;

  for (const ov of overlays) {
    const tile = await fetchTileRGBA(tileUrl(ov.urlTemplate, z, x, y), signal);
    if (!tile) continue;
    anyData = true;
    for (let i = 0; i < TILE_BYTES; i += 4) {
      const r = tile[i];
      const g = tile[i + 1];
      const b = tile[i + 2];
      // No overlay data here → keep what's below (the AWS baseline). LINZ marks out-of-coverage as
      // transparent (alpha 0); we also defensively treat the terrain-rgb "background" cyan (1,134,160),
      // which is exactly 0 m, as no-data so an opaque-backed gap can't overwrite the baseline with sea.
      // (A genuine 0.0 m pixel is sea level too, so falling through to the baseline there is harmless.)
      if (tile[i + 3] < 128 || (r === 1 && g === 134 && b === 160)) continue;
      const h = ov.encoding === 'mapbox' ? decodeMapbox(r, g, b) : decodeTerrarium(r, g, b);
      encodeTerrarium(h, out, i);
    }
  }

  return anyData ? out : null;
}

// ── Shared composited-tile cache ───────────────────────────────────────────────────────────────────
// ONE per-tile LRU of composited Terrarium RGBA, shared by every consumer of the surface: the map's
// meshdem:// protocol handler AND the sim's heightmap fetches (heightmap.ts). The win is twofold —
// neither side re-does the expensive fetch+decode+per-pixel composite the other already did, and a sim
// run leaves the map's 3D terrain warm (the handler reuses what the sim composited, and vice versa).
// Keyed by base template + every active overlay's template + z/x/y, so any change to which overlays
// are enabled (or their URLs) is a clean cache miss, never a wrong-surface hit. The browser HTTP cache
// only saves the network round-trip; the recomposite is what this avoids.
// Sized to hold a full coverage LOD stack (~384 tiles, fetched finest-first) plus a map viewport
// without evicting the inner z14 ring the 3D view shows zoomed to the TX. ~128 MB at 256×256×4 B/tile;
// drop no lower than ~450 (inner-ring eviction during a max-radius coverage), raise toward 768 only if
// a profile corridor (~192) and a full coverage stack must stay warm at once.
const TILE_CACHE_MAX = 512;
const compositeCache = new Map<string, RgbaBytes>();
// In-flight composites keyed identically to compositeCache: concurrent callers for the same tile join
// ONE shared composite instead of each re-running fetch+per-pixel composite (happens constantly during
// a link-matrix run — overlapping endpoint discs share tiles — and between the sim and the meshdem://
// handler). The shared run is detached from any one caller's signal and self-aborts on a timeout, so a
// stuck backend tile clears its entry rather than wedging future callers awaiting it forever.
const inflightComposites = new Map<string, Promise<RgbaBytes | null>>();
// Mirrors heightmap.ts's TILE_TIMEOUT_MS: a stuck/slow backend tile must self-abort so its inflight
// entry clears and later callers don't await it forever (a timed-out tile stays null → retryable).
const COMPOSITE_TIMEOUT_MS = 15000;
function cacheKey(baseTemplate: string, overlays: OverlaySpec[], z: number, x: number, y: number): string {
  return `${baseTemplate}|${overlays.map((o) => o.urlTemplate).join(',')}|${z}|${x},${y}`;
}
function compositeCacheGet(key: string): RgbaBytes | undefined {
  const hit = compositeCache.get(key);
  if (hit) {
    compositeCache.delete(key); // LRU bump
    compositeCache.set(key, hit);
  }
  return hit;
}
function compositeCachePut(key: string, tile: RgbaBytes): void {
  compositeCache.set(key, tile);
  while (compositeCache.size > TILE_CACHE_MAX) {
    const oldest = compositeCache.keys().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    compositeCache.delete(oldest);
  }
}

// Cached front door to composeTerrariumTileRGBA — what all callers should use. A cache HIT returns the
// shared array instantly (without touching `signal`, so an already-aborted run still gets a free tile);
// a MISS composites under `signal` and stores only a non-null full result, so a timed-out/aborted tile
// is never cached and stays retryable next run. The returned array is SHARED BY REFERENCE and must be
// treated READ-ONLY (clone before mutating); every current consumer only reads it.
export async function composeTerrariumTileRGBACached(
  z: number,
  x: number,
  y: number,
  baseTemplate: string,
  overlays: OverlaySpec[],
  signal?: AbortSignal,
): Promise<RgbaBytes | null> {
  const key = cacheKey(baseTemplate, overlays, z, x, y);
  const hit = compositeCacheGet(key);
  if (hit) {
    return hit;
  }

  // Join an existing in-flight composite for this tile, or start the one shared run.
  let shared = inflightComposites.get(key);
  if (!shared) {
    shared = (async (): Promise<RgbaBytes | null> => {
      // Detached from every caller's signal — other waiters may still need the result — so it runs under
      // its OWN controller, aborted only by the timeout. A null/timed-out tile is never cached (stays
      // retryable); the finally clears the inflight entry so nothing can wedge the map forever.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), COMPOSITE_TIMEOUT_MS);
      try {
        const rgba = await composeTerrariumTileRGBA(z, x, y, baseTemplate, overlays, ctrl.signal);
        if (rgba) {
          compositeCachePut(key, rgba);
        }
        return rgba;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        inflightComposites.delete(key);
      }
    })();
    inflightComposites.set(key, shared);
  }

  // Honour this caller's own signal WITHOUT cancelling the shared work the other waiters depend on.
  if (!signal) {
    return shared;
  }
  if (signal.aborted) {
    return null;
  }
  return new Promise<RgbaBytes | null>((resolve) => {
    const onAbort = (): void => resolve(null); // callers treat null as the sea sentinel
    signal.addEventListener('abort', onAbort);
    void shared!.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(null);
      },
    );
  });
}

// Re-encode composited RGBA to a PNG ArrayBuffer for MapLibre to consume as a raster-dem tile.
async function rgbaToPng(rgba: RgbaBytes): Promise<ArrayBuffer> {
  const cv = new OffscreenCanvas(TILE, TILE);
  const cx = cv.getContext('2d')!;
  cx.putImageData(new ImageData(rgba, TILE, TILE), 0, 0);
  const blob = await cv.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

const TILE_RE = new RegExp(`^${DEM_SCHEME}://(\\d+)/(\\d+)/(\\d+)`);

// Register the `meshdem://{z}/{x}/{y}` protocol. Stateless except for `getOverlays`, which is called
// fresh on every tile request — not snapshotted — so a provider add/edit/delete/toggle is reflected on
// the next fetch without re-registering the protocol. Each tile is every currently-enabled overlay
// composited over the AWS baseline, re-encoded to a Terrarium PNG. (The no-overlay map state points
// the source straight at the AWS URL, so this protocol only runs with at least one overlay on.)
export function registerDemProtocol(
  maplibregl: { addProtocol: (scheme: string, fn: AddProtocolFn) => void },
  getOverlays: () => OverlaySpec[],
): void {
  maplibregl.addProtocol(DEM_SCHEME, async (params, abortController) => {
    const m = TILE_RE.exec(params.url);
    if (!m) throw new Error(`bad ${DEM_SCHEME} url: ${params.url}`);
    const z = +m[1];
    const x = +m[2];
    const y = +m[3];
    const rgba = await composeTerrariumTileRGBACached(
      z, x, y, AWS_TERRARIUM_TEMPLATE, getOverlays(), abortController.signal,
    );
    if (!rgba) throw new Error(`no terrain data for ${z}/${x}/${y}`);
    return { data: await rgbaToPng(rgba) };
  });
}

// ── Provider testing ────────────────────────────────────────────────────────────────────────────────
// Lets the settings UI fetch one real tile from a provider's URL before saving it, catching a bad
// URL/key/CORS/encoding early instead of only finding out once it's composited into the live terrain.
export interface ProviderTestResult {
  ok: boolean;
  message: string;
}

function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y)) };
}

// Fetches the tile covering (lon, lat) — the map's current centre, passed in by the caller — at the
// shared DEM_MAXZOOM, and sanity-checks its centre pixel decodes to a plausible elevation.
export async function testProviderTile(
  urlTemplate: string,
  encoding: 'mapbox' | 'terrarium',
  lon: number,
  lat: number,
): Promise<ProviderTestResult> {
  if (!urlTemplate.includes('{z}') || !urlTemplate.includes('{x}') || !urlTemplate.includes('{y}')) {
    return { ok: false, message: 'URL must contain {z}, {x} and {y}.' };
  }
  const { x, y } = lonLatToTileXY(lon, lat, DEM_MAXZOOM);
  const tile = await fetchTileRGBA(tileUrl(urlTemplate, DEM_MAXZOOM, x, y));
  if (!tile) {
    return { ok: false, message: 'Fetch failed — check the URL, CORS, or API key.' };
  }
  const i = (128 * TILE + 128) * 4;
  if (tile[i + 3] < 128) {
    return {
      ok: false,
      message: 'Fetched, but the centre pixel is marked no-data here — try testing over an area this provider covers (pan the map first).',
    };
  }
  const h = encoding === 'mapbox'
    ? decodeMapbox(tile[i], tile[i + 1], tile[i + 2])
    : decodeTerrarium(tile[i], tile[i + 1], tile[i + 2]);
  if (!Number.isFinite(h) || h < -500 || h > 9000) {
    return { ok: false, message: `Decoded an implausible elevation (${h.toFixed(0)} m) — double check the encoding setting.` };
  }
  return { ok: true, message: `Looks good — ${h.toFixed(0)} m at the map centre.` };
}

// MapLibre v5's AddProtocolAction shape, kept local so this module doesn't import maplibre types.
type AddProtocolFn = (
  params: { url: string },
  abortController: AbortController,
) => Promise<{ data: ArrayBuffer }>;
