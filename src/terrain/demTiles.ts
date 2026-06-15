// Browser-only DEM tile compositor. The app's terrain (3D mesh, hillshade) AND the client-side RF
// sim/viewshed all read ONE raster-dem surface; this module produces it. The global baseline is AWS
// Terrarium (free, whole-world, no key, Terrarium-encoded). On top of it we can layer higher-detail
// overlays *where they have data* — first overlay is LINZ Basemaps elevation (NZ 1 m LIDAR DEM), which
// is Mapbox-encoded and marks out-of-coverage pixels as transparent. The composite is normalised to
// Terrarium encoding so every downstream decoder (the GPU viewshed shader, profile.ts) is unchanged.
//
// Two consumers share `composeTerrariumTileRGBA`:
//   - the map, via `registerDemProtocol` (MapLibre addProtocol → re-encodes the RGBA to a PNG); and
//   - the sim/viewshed, via heightmap.ts (writes the RGBA straight into its mosaic, no PNG round-trip).
// Both fetch the same underlying AWS/LINZ URLs, so the browser HTTP cache stays warm across them.

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

// Which LINZ surface model the overlay draws: bare-earth DEM or surface DSM (buildings/vegetation).
export type LinzModel = 'dem' | 'dsm';

// The LINZ overlay spec for a surface model. Mapbox-encoded; the compositor normalises it to Terrarium.
export function linzOverlaySpec(model: LinzModel): OverlaySpec {
  return { urlTemplate: model === 'dsm' ? LINZ_DSM_TEMPLATE : LINZ_DEM_TEMPLATE, encoding: 'mapbox' };
}

const TILE = 256;
const TILE_BYTES = TILE * TILE * 4;

// RGBA backed by a plain ArrayBuffer (not the widened ArrayBufferLike of ImageData.data), so it
// satisfies the ImageData constructor and heightmap.ts's GPU upload. The buffer really is an
// ArrayBuffer at runtime; the cast just narrows the type (same pattern as heightmap.ts).
type RgbaBytes = Uint8ClampedArray<ArrayBuffer>;

// --- height <-> RGB codecs -------------------------------------------------------------------------

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

// --- tile fetch + decode ---------------------------------------------------------------------------

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

// --- the composite ---------------------------------------------------------------------------------

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

// --- map source (MapLibre addProtocol) -------------------------------------------------------------

// Re-encode composited RGBA to a PNG ArrayBuffer for MapLibre to consume as a raster-dem tile.
async function rgbaToPng(rgba: RgbaBytes): Promise<ArrayBuffer> {
  const cv = new OffscreenCanvas(TILE, TILE);
  const cx = cv.getContext('2d')!;
  cx.putImageData(new ImageData(rgba, TILE, TILE), 0, 0);
  const blob = await cv.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

const TILE_RE = new RegExp(`^${DEM_SCHEME}://(dem|dsm)/(\\d+)/(\\d+)/(\\d+)`);

// Register the `meshdem://{model}/{z}/{x}/{y}` protocol (model = dem|dsm). The model lives in the URL,
// not a closure, so the handler is stateless AND switching DEM↔DSM changes the tile URLs — setTiles
// then reloads the source cleanly instead of serving stale cached tiles. Each tile is the LINZ model
// composited over the AWS baseline, re-encoded to a Terrarium PNG. (The overlay-OFF map points the
// source straight at the AWS URL, so this protocol only runs with the overlay on.)
export function registerDemProtocol(
  maplibregl: { addProtocol: (scheme: string, fn: AddProtocolFn) => void },
): void {
  maplibregl.addProtocol(DEM_SCHEME, async (params, abortController) => {
    const m = TILE_RE.exec(params.url);
    if (!m) throw new Error(`bad ${DEM_SCHEME} url: ${params.url}`);
    const model = m[1] as LinzModel;
    const z = +m[2];
    const x = +m[3];
    const y = +m[4];
    const rgba = await composeTerrariumTileRGBA(
      z, x, y, AWS_TERRARIUM_TEMPLATE, [linzOverlaySpec(model)], abortController.signal,
    );
    if (!rgba) throw new Error(`no terrain data for ${z}/${x}/${y}`);
    return { data: await rgbaToPng(rgba) };
  });
}

// MapLibre v5's AddProtocolAction shape, kept local so this module doesn't import maplibre types.
type AddProtocolFn = (
  params: { url: string },
  abortController: AbortController,
) => Promise<{ data: ArrayBuffer }>;
