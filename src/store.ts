import { defineStore } from 'pinia';
import { useLocalStorage } from '@vueuse/core';
import { watch, markRaw } from 'vue';
import { randanimalSync } from 'randanimal';
import maplibregl from 'maplibre-gl';
import { type Site, type SplatParams, type Node, type NodeGroup, type MatrixResult, type LinkResult, type RelayResult, type ProfileResult, type UiMode } from './types.ts';
import { cloneObject, escapeHtml, decodeShare, type SharePayload } from './utils.ts';
import { trackEvent } from './analytics.ts';
import { makePinElement, stylePinElement } from './layers.ts';
import { createElement, Ruler, Keyboard, Search } from 'lucide';
import { Popover } from 'bootstrap';
import { Links3DLayer, buildLinkGeometry, setLinkColorFn, type LinkPick } from './links3d.ts';
import { getHeightmap, type Heightmap } from './viewshed/heightmap.ts';
import {
  MAPTERHORN_TEMPLATE,
  DEM_MAXZOOM,
  DEM_SCHEME,
  builtinDemProviders,
  enabledOverlaySpecs,
  registerDemProtocol,
  testProviderTile,
  type DemProvider,
  type ProviderTestResult,
} from './terrain/demTiles.ts';
import { ViewshedEngine, type ViewshedComputeEngine } from './viewshed/gpu.ts';
import { Webgl2ViewshedEngine } from './viewshed/webgl2.ts';
import { runMatrix as runMatrixWorker, runProfile as runProfileWorker, runCoverage as runCoverageWorker, runRelay as runRelayWorker, type SimSource } from './sim/simClient.ts';
import type { ProfileOptions } from './sim/profile.ts';
import type { SimNode, SimShared } from './sim/links.ts';
import type { CoverageNode, CoverageOptions } from './sim/coverageTypes.ts';
import type { RelayParams } from './sim/relay.ts';
import { colorizeGrid } from './sim/colormap.ts';
import { receiverSensitivityDbm, MESHTASTIC_PRESETS, DEFAULT_PRESET } from './sim/linkBudget.ts';

const DEFAULT_LAT = -41.257053283864224;
const DEFAULT_LON = 174.86568331718445;

// The switchable raster basemaps. Subdomained hosts go in the tiles[] array so MapLibre rotates
// over them; single-host sources use one entry. Each carries its own attribution for the
// AttributionControl.
export const BASEMAPS = [
  {
    id: 'osm',
    label: 'OSM',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
  {
    id: 'carto',
    label: 'Carto Light',
    tiles: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap contributors © CARTO',
    maxzoom: 20,
  },
  {
    // Dark counterpart of Carto Light — its near-black, low-chroma palette lets the hillshade relief
    // overlay read far more clearly than it can over the pale light_all tiles.
    id: 'carto-dark',
    label: 'Carto Dark',
    tiles: [
      'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap contributors © CARTO',
    maxzoom: 20,
  },
  {
    id: 'satellite',
    label: 'Satellite',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Tiles © Esri — Source: Esri, USGS, NOAA',
    maxzoom: 19,
  },
  {
    // LINZ Basemaps NZ aerial imagery — higher detail than the global Esri 'Satellite', but NZ-only:
    // no tiles exist outside NZ, so the map is blank there. `aerial`/WebMercatorQuad, .webp for the
    // smallest payload. Needs VITE_LINZ_API_KEY (same free key as the DEM overlay; empty → blank).
    id: 'linz-aerial',
    label: 'Aerial Imagery',
    tiles: [`https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/{z}/{x}/{y}.webp?api=${import.meta.env.VITE_LINZ_API_KEY ?? ''}`],
    attribution: 'Aerial imagery © LINZ, CC-BY 4.0',
    maxzoom: 22,
  },
  {
    id: 'topo',
    label: 'Topo Map',
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
    ],
    // OpenTopoMap is CC-BY-SA — this attribution must remain visible.
    attribution: 'Map data: © OpenStreetMap contributors, SRTM | OpenTopoMap',
    maxzoom: 17,
  },
];

// Coverage rasters insert directly below the relay heatmap (which sits below links / points), so they
// sit above the basemap but under everything else. 'coverage-top' / 'relay-top' are empty, invisible
// anchor layers (see setupOverlays) that pin the z-slots for the two draped raster overlays — coverage
// rasters go before 'coverage-top', the relay heatmap before 'relay-top'. See setupOverlays for the
// full z-order.
const COVERAGE_BEFORE = 'coverage-top';
const RELAY_BEFORE = 'relay-top';
// The single browser-computed viewshed overlay (WebGPU LOS footprint). Shares the coverage z-slot:
// inserted before COVERAGE_BEFORE so it sits above the basemap/hillshade but under the vector overlays.
const VIEWSHED_ID = 'viewshed';
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Cap for the node undo stack (Ctrl+Z). Bounds memory; oldest entries drop first.
const NODE_HISTORY_LIMIT = 100;

// One entry per undoable node change. 'move' restores a prior position (drag/edit); 'delete'
// re-inserts a removed node at its original index and re-selects it if it was selected.
type NodeHistoryEntry =
  | { type: 'move'; nodeId: string; lat: number; lon: number }
  | { type: 'delete'; node: Node; index: number; wasSelected: boolean };

// Conservative floor for gl.MAX_TEXTURE_SIZE across GPUs; a coverage canvas larger than this on
// either axis is downsampled before upload so it never silently fails to render. Also the default
// (and old-Safari-safe) overlay cap: 4096² is exactly the historical 16.7M-px canvas-area limit.
const MAX_TEXTURE = 4096;

// Coverage overlay raster sizing, keyed by the quality preset. az/rangeSteps set the ITM budget
// (cost ≈ az × rangeSteps²/2, since each ray reruns ITM over a growing prefix). cellM is the TARGET
// ground cell size for the OUTPUT raster: the raster is sized to hit it over the chosen range, then
// clamped to [GRID_FLOOR, the texture cap]. The raster is cheap (decoupled from the ITM budget), so a
// finer cell only costs rasterization + memory and buys a sharper overlay. 'max' targets 8 m — the
// native LINZ DEM resolution — which it reaches at ranges up to (cap × cellM / 2); beyond that the
// texture cap (not the target) bounds the cell size.
const COVERAGE_PRESETS = {
  draft: { az: 360, rangeSteps: 160, cellM: 60 },
  balanced: { az: 540, rangeSteps: 224, cellM: 30 },
  high: { az: 720, rangeSteps: 320, cellM: 16 },
  max: { az: 1080, rangeSteps: 448, cellM: 8 },
} as const;
// Smallest output raster a coverage run uses, so a short-range pass still has a usable overlay.
const COVERAGE_GRID_FLOOR = 256;

// The GPU's real gl.MAX_TEXTURE_SIZE, queried once via a throwaway context and cached. Used to clamp
// the user's chosen overlay cap so a too-large texture can't silently fail to upload. Falls back to
// the conservative MAX_TEXTURE if WebGL is unavailable.
let gpuMaxTextureCache: number | null = null;
function gpuMaxTexture(): number {
  if (gpuMaxTextureCache != null) {
    return gpuMaxTextureCache;
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
    gpuMaxTextureCache = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : MAX_TEXTURE;
  } catch {
    gpuMaxTextureCache = MAX_TEXTURE;
  }
  return gpuMaxTextureCache ?? MAX_TEXTURE;
}

// Effective overlay texture cap: the user's chosen ceiling, clamped to what this GPU can upload.
// Note this does NOT model older Safari's separate canvas-AREA limit (16.7M px = 4096²) — picking a
// cap above 4096 is an explicit opt-in for capable browsers (the panel help text flags the cost).
function effectiveTextureCap(setting: number | undefined): number {
  return Math.min(setting ?? MAX_TEXTURE, gpuMaxTexture());
}

// Output raster dimension (px per side) for a coverage run: target the preset's cell size over the
// 2·radiusM span, clamped to [GRID_FLOOR, texture cap]. The resulting on-ground cell size is
// 2·radiusM / this — surfaced to the user via the coverageCellMeters getter.
function coverageGridSize(radiusM: number, preset: keyof typeof COVERAGE_PRESETS, cap: number): number {
  const target = Math.ceil((2 * radiusM) / COVERAGE_PRESETS[preset].cellM);
  return Math.min(cap, Math.max(COVERAGE_GRID_FLOOR, target));
}

// Colour a link by its margin: green (strong) -> red (marginal/none). Grey when unknown.
export function linkColor(margin: number | null): string {
  if (margin === null || margin === undefined) {
    return '#888888';
  }
  const t = Math.max(0, Math.min(1, margin / 30)); // saturate at +30 dB margin
  const r = Math.round(220 * (1 - t));
  const g = Math.round(40 + 150 * t);
  return `rgb(${r}, ${g}, 50)`;
}

// The popup body for a link, shared by the 2D line layers and the 3D-line click pick so both show
// identical details + the "Show line profile" button (wired to runProfile by the click handler).
function linkPopupHtml(link: LinkResult, aName: string, bName: string): string {
  const details = link.error
    ? `Error: ${escapeHtml(link.error)}`
    : `Margin: ${link.margin_db ?? '—'} dB<br>` +
      `Path loss: ${link.path_loss_db ?? '—'} dB<br>` +
      `Fresnel zone: ${link.fresnel_pct ?? '—'} % clear<br>` +
      `Distance: ${link.distance_km ?? '—'} km`;
  return `<strong>${escapeHtml(aName)} ↔ ${escapeHtml(bName)}</strong><br>${details}`
    + `<br><button type="button" class="link-profile-btn btn btn-sm btn-primary mt-2 w-100">Show line profile</button>`;
}

// The popup shown when a second node is shift-clicked: the pair, a button to compute the link +
// show its profile, and a button to search for a relay site between them (wired to runProfile /
// runRelay by showPairPopup). No metrics yet — they don't exist until the link is calculated.
function pairPopupHtml(aName: string, bName: string): string {
  return `<strong>${escapeHtml(aName)} ↔ ${escapeHtml(bName)}</strong>`
    + `<br><button type="button" class="pair-profile-btn btn btn-sm btn-primary mt-2 w-100">Calculate link &amp; show profile</button>`
    + `<br><button type="button" class="pair-relay-btn btn btn-sm btn-primary mt-2 w-100">Find relay zone</button>`;
}

// The single raster-dem source backing the 3D terrain mesh, the hillshade, and the client-side sim
// (matrix/profile/coverage/relay/viewshed). Baseline is always Mapterhorn (global, no key). With no
// provider enabled the source points straight at the Mapterhorn tiles (zero overhead); otherwise it
// points at the `meshdem://` protocol, which composites every enabled provider over Mapterhorn per
// pixel and returns Terrarium-encoded tiles — so `encoding` stays 'terrarium' either way and every
// downstream decoder is unchanged. Toggling a provider swaps the two URL forms live via setTiles.
function terrainDemSource(hasAnyOverlay: boolean): any {
  return {
    type: 'raster-dem',
    tiles: [hasAnyOverlay ? `${DEM_SCHEME}://{z}/{x}/{y}` : MAPTERHORN_TEMPLATE],
    // Declared 256 even though Mapterhorn natively serves 512 px webp: MapLibre derives the actual DEM
    // decode grid from each loaded image's real pixel size (not this field — it only steers which zoom
    // level gets requested), and setTiles (below) never updates this property once the source exists.
    // Pinning it at the meshdem:// compositor's true 256 px output keeps it correct for that path on
    // every toggle, at the cost of MapLibre overzooming the direct Mapterhorn path very slightly more
    // than the bare minimum needed — harmless, since DEM_MAXZOOM caps how deep that can go anyway.
    tileSize: 256,
    // 'terrarium' is mandatory: these tiles decode to garbage under the default mapbox encoding. The
    // composited overlay tiles are normalised to Terrarium too, so this holds for both URL forms.
    encoding: 'terrarium',
    // minzoom 0 so MapLibre requests terrain at every zoom (the map opens at z10); overzooms past
    // maxzoom rather than fetching finer tiles that don't exist.
    minzoom: 0,
    maxzoom: DEM_MAXZOOM,
    attribution: 'Terrain: Mapterhorn (Copernicus / national LiDAR) · LINZ CC-BY 4.0',
  };
}

// Build the initial MapLibre style: the raster basemaps (the persisted one visible) plus the
// terrain raster-dem for 3D terrain, draped via the style's `terrain` when enabled so both render on
// the first frame. Overlay sources/layers are added later, on 'load'.
function buildStyle(
  activeBasemap: string,
  terrainEnabled: boolean,
  terrainExaggeration: number,
  hasAnyOverlay: boolean,
): any {
  const sources: Record<string, any> = {};
  const layers: any[] = [];
  // Fall back to the first basemap if the persisted id is unknown, so a stale value can't leave
  // every basemap hidden (a blank map).
  const visibleId = BASEMAPS.some((b) => b.id === activeBasemap) ? activeBasemap : BASEMAPS[0].id;
  BASEMAPS.forEach((b) => {
    sources[b.id] = { type: 'raster', tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom };
    layers.push({ id: `basemap-${b.id}`, type: 'raster', source: b.id, layout: { visibility: b.id === visibleId ? 'visible' : 'none' } });
  });
  sources['terrain-dem'] = terrainDemSource(hasAnyOverlay);
  const style: any = { version: 8, sources, layers };
  // Top-level `terrain` drapes the map over the DEM; runtime toggles go through setTerrain.
  if (terrainEnabled) {
    style.terrain = { source: 'terrain-dem', exaggeration: terrainExaggeration };
  }
  return style;
}

// One-time migration for users upgrading from the old linzOverlay/linzModel pair (a boolean + a
// dem|dsm radio) to the generic builtin-provider-enabled map. Reads the raw legacy keys directly
// since they're being retired — nothing else reads them after this. Only consulted the very first
// time builtinProviderEnabled's own key doesn't exist yet; the old keys are left behind afterward
// (orphaned, harmless).
function migrateLegacyLinzEnabled(): Record<string, boolean> {
  try {
    const wasOn = JSON.parse(localStorage.getItem('linzOverlay') ?? 'false') === true;
    const model = JSON.parse(localStorage.getItem('linzModel') ?? '"dem"');
    return { 'builtin-linz-dem': wasOn && model === 'dem', 'builtin-linz-dsm': wasOn && model === 'dsm' };
  } catch {
    return {};
  }
}

const DEG2RAD = Math.PI / 180;
function mercatorY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG2RAD) / 2));
}
function inverseMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG2RAD;
}

// MapLibre image/canvas sources don't reproject: they stretch the image linearly in Web-Mercator Y
// between the corner coordinates, while the input canvas rows are evenly spaced in latitude. For a tall
// extent at high latitude that mismatch shows up as a north-south coverage offset (zero at the top
// and bottom edges, up to a few hundred metres mid-image). Resample the canvas so its rows are
// evenly spaced in Mercator Y; MapLibre's linear interpolation then lands each row at the right
// latitude. Rows are copied whole with nearest sampling, so palette colours/nodata stay exact.
function mercatorWarp(src: HTMLCanvasElement, north: number, south: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  if (h < 2 || north <= south) {
    return src;
  }
  const srcData = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const dst = octx.createImageData(w, h);
  const yN = mercatorY(north);
  const yS = mercatorY(south);
  const span = north - south;
  const rowBytes = w * 4;
  for (let r = 0; r < h; r++) {
    // Output row r (pixel centre) sits at this Mercator Y -> latitude -> source row (centre).
    const lat = inverseMercatorY(yN + (yS - yN) * ((r + 0.5) / h));
    let sr = Math.round(((north - lat) / span) * h - 0.5);
    if (sr < 0) sr = 0;
    else if (sr >= h) sr = h - 1;
    const so = sr * rowBytes;
    dst.data.set(srcData.subarray(so, so + rowBytes), r * rowBytes);
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

// Resize the coverage canvas so MapLibre can actually render it: cap either axis at MAX_TEXTURE,
// and never hand it a square power-of-two canvas. MapLibre binds image/canvas-source textures with
// a LINEAR_MIPMAP_NEAREST min filter and only downgrades to plain LINEAR when the texture is NOT a
// square power-of-two (Texture.isSizePowerOfTwo). A square-POT canvas — a common SPLAT output, e.g.
// 1024² or a 4096² downscale — would then be sampled against mipmaps that were never generated,
// leaving the texture "incomplete", which WebGL renders as opaque black. Pixel dimensions don't
// affect geo-registration (the four corner coordinates do), so shrinking one axis a pixel is free.
function fitCoverageCanvas(canvas: HTMLCanvasElement, maxTexture = MAX_TEXTURE): HTMLCanvasElement {
  let w = canvas.width;
  let h = canvas.height;
  const max = Math.max(w, h);
  if (max > maxTexture) {
    const scale = maxTexture / max;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  if (w === h && isPow2(w)) {
    w -= 1; // break the square power-of-two (see comment above)
  }
  if (w === canvas.width && h === canvas.height) {
    return canvas;
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = false; // nearest-neighbour keeps dBm band edges crisp
  ctx.drawImage(canvas, 0, 0, w, h);
  return out;
}

// Folder that bulk-imported MeshCore contacts land in; reused across re-imports (see importContacts).
const IMPORTED_FOLDER_NAME = 'Imported';
// Folder that public-map sync (MeshCore/MeshMapper) drops nodes into; reused across re-syncs (see
// importPublicMapNodes).
const PUBLIC_MAP_FOLDER_NAME = 'Public MeshCore';

function defaultTransmitter(freqOverride?: number): SplatParams['transmitter'] {
  return {
    name: randanimalSync(),
    tx_lat: DEFAULT_LAT,
    tx_lon: DEFAULT_LON,
    tx_power: 0.1,
    tx_freq: freqOverride ?? 907.0,
    tx_height: 2.0,
    tx_gain: 2.0
  };
}

function defaultReceiver(): SplatParams['receiver'] {
  return {
    rx_sensitivity: -130.0,
    rx_height: 1.0,
    rx_gain: 2.0,
    rx_loss: 2.0
  };
}

function seedNode(): Node {
  return {
    id: crypto.randomUUID(),
    transmitter: defaultTransmitter(),
    receiver: defaultReceiver()
  };
}

// Vue watch stop-handles for the map's reactive bindings. Tracked at module scope so a remount
// (Vite HMR / navigation) can stop the old watchers in destroyMap rather than accumulate them.
let watchStops: Array<() => void> = [];

// The 3D-links custom layer and its rebuild debounce. Module-scoped (not Pinia state) for the same
// reason as the Map: GL/three objects must never be deep-proxied by Vue (see [[maplibre-isstyleloaded]]
// and the markRaw note in initMap). map.remove() in destroyMap tears the layer's GL down with it.
let links3dLayer: Links3DLayer | null = null;
let rebuild3dTimer: ReturnType<typeof setTimeout> | null = null;
// Debounce handle for re-running the link matrix when a link-affecting setting changes (radio params,
// shared environment, lora preset, node coords). Coalesces keystroke/slider bursts into one ITM run.
let matrixRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
// Debounce handle for refreshing an open profile when one of its endpoints moves. Coalesces a burst
// of lat/lon keystrokes into one recompute (a drag-drop is a single event, so it fires once anyway).
let profileRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
// Elevated per-link polylines for click hit-testing the 3D lines (the 2D click target is offset
// from the visible 3D line once the camera tilts). Rebuilt alongside the geometry.
let links3dPicks: LinkPick[] = [];
// Whether the 3D-line hover handler currently owns the cursor, so it only clears a cursor it set.
let cursor3dActive = false;
let measureControl: MeasureControl | null = null;
// Set when a double-click finishes a line: freezes it (no rubber-band) until the next click starts anew.
let measureFinished = false;
// Measure vertex being dragged, or -1 when none.
let measureDragIndex = -1;
// Last pointer position over the map (lng/lat), so the "A" hotkey can drop a node under the cursor.
// Null while the pointer is off the canvas, so the shortcut falls back to the map centre then.
let lastMapCursor: maplibregl.LngLat | null = null;
let locationSearchControl: LocationSearchControl | null = null;
// Right-mousedown point, so 'contextmenu' can tell a click from a rotate-drag release.
let rightMouseDownPoint: { x: number; y: number } | null = null;
// Keys of tiles currently loading across all sources, for the bottom loading bar. Module-scoped (not
// in reactive state) so updating a hot Set per tile event doesn't churn Vue's proxy; its size is
// mirrored into store.mapTiles.inFlight. Reset on map teardown.
const mapTileInflight = new Set<string>();
// Ids of node markers currently attached to the map. MapLibre rewrites every attached marker's DOM
// transform on each pan frame, so 300 off-screen pins would jank panning; cullMarkers() keeps only
// the in-view subset attached. Module-scoped (not Pinia state) so per-pan toggling never churns Vue's
// proxy. Cleared on map teardown.
const attachedMarkers = new Set<string>();
// The on-map popup offering to compute a shift-clicked node pair. Module-scoped (like the Map) so
// Vue never proxies the GL popup; only one is ever open at a time.
let pairPopup: maplibregl.Popup | null = null;
// The viewshed compute engine (WebGPU when available, WebGL2 otherwise — see acquireViewshedEngine)
// + its scheduling/result handles. Module-scoped (not Pinia state) for the same reason as the Map and
// the 3D layer: the GPUDevice/WebGL2 context and the result canvas must never be deep-proxied by Vue.
// The engine survives mode switches; destroyMap disposes it. viewshedComputing/viewshedDirty coalesce
// overlapping recomputes (a drag can outrun a single async compute).
let viewshedEngine: ViewshedComputeEngine | null = null;

// Try WebGPU first (currently the faster/more capable backend where available), then WebGL2 — which
// covers virtually every phone WebGPU doesn't. Returns null only when neither is supported/working.
async function acquireViewshedEngine(): Promise<ViewshedComputeEngine | null> {
  if (ViewshedEngine.isSupported()) {
    const engine = new ViewshedEngine();
    if (await engine.init()) {
      return engine;
    }
  }
  if (Webgl2ViewshedEngine.isSupported()) {
    const engine = new Webgl2ViewshedEngine();
    if (await engine.init()) {
      return engine;
    }
  }
  return null;
}
let viewshedRaf = 0; // rAF handle for live (per-frame) recompute throttling; 0 = none pending
let viewshedTimer: ReturnType<typeof setTimeout> | null = null; // debounce handle for move-end/param recompute
let viewshedResultCanvas: HTMLCanvasElement | null = null;
let viewshedCoords: Site['coords'] | null = null;
let viewshedComputing = false;
let viewshedDirty = false;
// The (rounded) map zoom the current viewshed was fetched at, so a moveend only re-fetches when the
// zoom level actually changes (panning hits the same tiles). -1 = none computed yet.
let viewshedLastZoom = -1;
// Serialises GPU passes: the viewshed re-renders progressively as terrain tiles stream in, but the
// engine reuses one set of GPU buffers, so two compute()s must never overlap. Progressive frames are
// dropped while a pass is in flight; the final pass waits for it. Null = idle.
let viewshedPassPromise: Promise<void> | null = null;
// Cancel handles for the in-flight client-side sim jobs, so a fresh run supersedes the previous one
// (its stale worker results are dropped rather than overwriting the new run's).
let matrixCancel: (() => void) | null = null;
let profileCancel: (() => void) | null = null;
let coverageCancel: (() => void) | null = null;
let relayCancel: (() => void) | null = null;
// Share the link palette with the 3D layer so its chords match the 2D links exactly.
setLinkColorFn(linkColor);

// Distance from point p to segment a-b, in pixels; used to hit-test a click against a projected line.
function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

// A native MapLibre control (not a Vue overlay like the rest) so the toggle stacks in the same corner
// as the zoom/compass buttons.
class MeasureControl implements maplibregl.IControl {
  private container!: HTMLElement;
  private button!: HTMLButtonElement;
  constructor(private onToggle: () => void) {}
  onAdd(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'measure-ctrl-btn';
    this.button.title = 'Measure distance — click points on the map; double-click to finish';
    this.button.setAttribute('aria-label', 'Measure distance');
    const svg = createElement(Ruler);
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    this.button.appendChild(svg);
    this.button.addEventListener('click', () => this.onToggle());
    this.container.appendChild(this.button);
    return this.container;
  }
  onRemove(): void {
    this.container.remove();
  }
  setActive(active: boolean): void {
    this.button.classList.toggle('measure-ctrl-active', active);
    this.button.setAttribute('aria-pressed', String(active));
  }
}

// A native MapLibre control (like MeasureControl) so it stacks bottom-left above the measure tool. A
// keyboard icon whose hover/focus popover documents the app's keyboard shortcuts.
class HotkeyHelpControl implements maplibregl.IControl {
  private container!: HTMLElement;
  private button!: HTMLButtonElement;
  private popover: Popover | null = null;
  onAdd(): HTMLElement {
    this.container = document.createElement('div');
    // hotkey-help-ctrl is a hook for hiding the whole control on phone (no keyboard to document).
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group hotkey-help-ctrl';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'hotkey-help-btn';
    this.button.setAttribute('aria-label', 'Keyboard shortcuts');
    const svg = createElement(Keyboard);
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    this.button.appendChild(svg);
    this.container.appendChild(this.button);
    // container:'body' so the map's overflow can't clip it; placement:'top' since it sits at the
    // screen bottom. Disposed in onRemove so the body-appended element doesn't leak on teardown/HMR.
    this.popover = new Popover(this.button, {
      html: true,
      title: 'Keyboard shortcuts',
      content:
        '<dl class="hotkey-help-list mb-0">' +
        '<dt>A</dt><dd>Add a node at the cursor</dd>' +
        '<dt>Ctrl + Z</dt><dd>Undo last node change</dd>' +
        '<dt>H</dt><dd>Hide / show selected node</dd>' +
        '<dt>L</dt><dd>Calulate links for selected node</dd>' +
        '<dt>C</dt><dd>Calculate coverage for selected node</dd>' +
        '<dt>Delete</dt><dd>Delete selected node</dd>' +
        '</dl>',
      trigger: 'hover focus',
      placement: 'top',
      container: 'body',
    });
    return this.container;
  }
  onRemove(): void {
    this.popover?.dispose();
    this.popover = null;
    this.container.remove();
  }
}

// Native control (like MeasureControl/HotkeyHelpControl); toggles the LocationSearchPanel overlay.
class LocationSearchControl implements maplibregl.IControl {
  private container!: HTMLElement;
  private button!: HTMLButtonElement;
  constructor(private onToggle: () => void) {}
  onAdd(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'location-search-btn';
    this.button.title = 'Search for a place or address';
    this.button.setAttribute('aria-label', 'Search for a location');
    const svg = createElement(Search);
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    this.button.appendChild(svg);
    this.button.addEventListener('click', () => this.onToggle());
    this.container.appendChild(this.button);
    return this.container;
  }
  onRemove(): void {
    this.container.remove();
  }
  setActive(active: boolean): void {
    this.button.classList.toggle('location-search-active', active);
    this.button.setAttribute('aria-pressed', String(active));
  }
}

const useStore = defineStore('store', {
  state() {
    return {
      // Typed `any` in state: MapLibre's Map type is too deep for Pinia's reactive state-type
      // unwrap (it trips TS2589), so methods cast this.map to a typed local instead. It's markRaw'd
      // at assignment, so it is never actually made reactive (see initMap / [[leaflet-markraw]]).
      map: undefined as any,
      nodeMarkers: {} as Record<string, maplibregl.Marker>,
      dragging: false,
      // A share link opened in the URL (#s=…), parsed but NOT yet applied: the confirm banner
      // (SharedLinkBanner) shows it and the user picks Add (applyIncomingShare) or Dismiss. In-memory
      // only — the hash is stripped the moment it's parsed, so a reload/HMR remount never re-triggers.
      incomingShare: null as SharePayload | null,
      activeBasemap: useLocalStorage('activeBasemap', 'osm'),
      // Opt-in to the NZ-only 'Satellite (NZ)' (LINZ aerial) basemap button. Off by default so the
      // picker stays uncluttered for non-NZ users; when on, availableBasemaps reveals the button.
      nzBasemapEnabled: useLocalStorage('nzBasemapEnabled', false),
      // Which sidebar panel the top-bar mode toggle shows. Persisted so the chosen mode survives reload.
      activeMode: useLocalStorage<UiMode>('activeMode', 'nodes'),
      localSites: [] as Site[], // in-memory only (raster/canvas are not JSON-serializable)
      simulationState: 'idle',
      // Live progress for the active job (coverage/matrix/relay).
      progress: null as { message: string; fraction: number | null } | null,
      matrixState: 'idle',
      matrixResult: null as MatrixResult | null, // in-memory only
      relayState: 'idle',
      relayResult: null as RelayResult | null, // in-memory only
      // The relay zone draped as a smooth heatmap (same canvas-source path coverage uses): the
      // colorized margin canvas (markRaw'd, non-reactive) and its four corner coords [lng,lat]
      // (TL,TR,BR,BL). Built in runRelay, drawn by redrawRelay. In-memory only.
      relayImage: null as HTMLCanvasElement | null,
      relayCoords: null as Site['coords'] | null,
      relayA: null as string | null, // selected endpoint node ids
      relayB: null as string | null,
      // Point-to-point terrain/LOS profile (bottom strip). In-memory only; the two endpoint ids
      // drive both the chart header and the on-map path line.
      profileState: 'idle',
      profileResult: null as ProfileResult | null,
      profileError: null as string | null,
      profileFromId: null as string | null,
      profileToId: null as string | null,
      // The node shift-clicked while another is selected: drives the dashed preview link and the
      // "calculate link" popup. In-memory only; it's a transient selection, not a saved setting.
      pairTargetId: null as string | null,
      // Lazy cache of computed profiles, keyed by the full request payload (so any change to a node
      // or radio param yields a new key and recomputes). In-memory only; entries are markRaw'd.
      profileCache: {} as Record<string, ProfileResult>,
      // The "other" node chosen in the Check-LOS dropdown. Persisted so the choice survives reload.
      losTargetId: useLocalStorage<string | null>('losTargetId', null),
      // 3D terrain (draped from the terrain raster-dem). Persisted so the view survives a reload.
      terrainEnabled: useLocalStorage('terrainEnabled', false),
      terrainExaggeration: useLocalStorage('terrainExaggeration', 1),
      // User-added DEM/DSM overlay providers — analogous to the built-in LINZ rows (builtinDemProviders
      // in demTiles.ts) but for any region. Each layers over the Mapterhorn baseline where it has
      // data, like LINZ. Drives the terrain-dem source URL (Mapterhorn vs the meshdem:// compositor) and
      // the sim/viewshed — see the allDemProviders getter.
      customDemProviders: useLocalStorage<DemProvider[]>('customDemProviders', []),
      // Enabled state for the built-in (LINZ) rows, keyed by their fixed id — kept separate from
      // customDemProviders since builtins' urlTemplate/name must always come fresh from demTiles.ts
      // (e.g. a future LINZ key rotation), never frozen into a persisted provider object. Off by
      // default so the map keeps the zero-overhead direct-Mapterhorn path until the user opts in. The default
      // migrates any pre-existing linzOverlay/linzModel value so upgrading users don't lose their
      // setting.
      builtinProviderEnabled: useLocalStorage<Record<string, boolean>>('builtinProviderEnabled', migrateLegacyLinzEnabled()),
      // The 3D line-of-sight links (chords through the air + masts + drop-curtains). When off, the
      // flat 2D draped links show at full opacity instead. Only render with 3D terrain on. Persisted.
      links3dEnabled: useLocalStorage('links3dEnabled', true),
      // Whether the drop-curtain part of the 3D links is drawn. Persisted.
      linkCurtainEnabled: useLocalStorage('linkCurtainEnabled', true),
      // Opacity (0..1) of the translucent curtain dropped from each 3D link to the ground. Persisted.
      linkCurtainOpacity: useLocalStorage('linkCurtainOpacity', 0.5),
      // When true, the map shows ONLY links touching the selected node (viable or not) — the rest are
      // hidden entirely. When false, the default applies: viable links always show, non-viable ones
      // only for the selected node. Both feed visibleLinks. Persisted.
      linksSelectedOnly: useLocalStorage('linksSelectedOnly', false),
      // When true, non-viable links are hidden everywhere — including those touching the selected node
      // (which visibleLinks otherwise keeps). Default off. Persisted.
      hideInvalidLinks: useLocalStorage('hideInvalidLinks', false),
      // In-flight map tile tracker for the bottom loading bar (basemap + terrain + sim tiles). inFlight
      // mirrors the size of a non-reactive key set; peak is the high-water mark since it last hit zero,
      // so a fraction (peak-inFlight)/peak fills smoothly per burst. In-memory only.
      mapTiles: { inFlight: 0, peak: 0 } as { inFlight: number; peak: number },
      // Relief shading: a MapLibre hillshade layer over the same raster-dem. Independent of 3D — it
      // reads relief on flat solid-colour basemaps too. hillshade-exaggeration is a 0..1 intensity.
      hillshadeEnabled: useLocalStorage('hillshadeEnabled', false),
      hillshadeExaggeration: useLocalStorage('hillshadeExaggeration', 0.3),
      // Browser-computed line-of-sight viewshed (WebGPU). A fast, visible-only green footprint of what
      // the selected node can see — an alternative to the slow backend SPLAT run for nearby checks.
      // Reads whatever surface the map's terrain-dem source is currently using. Persisted prefs;
      // viewshedState is in-memory (it's runtime status, incl. 'unsupported' on non-WebGPU browsers).
      viewshedEnabled: useLocalStorage('viewshedEnabled', false),
      viewshedLive: useLocalStorage('viewshedLive', false), // recompute continuously while dragging vs on drop
      viewshedRadiusKm: useLocalStorage('viewshedRadiusKm', 10),
      viewshedOpacity: useLocalStorage('viewshedOpacity', 0.5),
      viewshedTargetHeight: useLocalStorage('viewshedTargetHeight', 0), // receiver AGL at tested cells (m)
      viewshedState: 'idle' as 'idle' | 'computing' | 'ready' | 'error' | 'unsupported',
      // Tile-fetch progress while terrain streams in (null when not loading). In-memory only; drives
      // the panel's "Loading terrain… N/M tiles" indicator so a slow LINZ fetch never looks frozen.
      viewshedProgress: null as { loaded: number; total: number } | null,
      nodes: useLocalStorage<Node[]>('nodes', [seedNode()]),
      // Undo stack for node changes — marker drags, panel lat/lon edits, and node deletion. Ctrl+Z
      // pops and reverses the most recent entry (see undoLastNodeChange + keyboard.ts). In-memory
      // only: undo across reloads would be surprising.
      nodeHistory: [] as NodeHistoryEntry[],
      // User-created folders for the node list (single-level). Display order = array order; a node's
      // membership lives on the node (Node.groupId). Empty by default; persisted across reloads.
      groups: useLocalStorage<NodeGroup[]>('nodeGroups', []),
      selectedNodeId: useLocalStorage<string | null>('selectedNodeId', null),
      // When set, node markers are non-draggable so they can't be moved by accident. Persisted so
      // the lock survives a reload. Manual lat/lon edits in the panel still apply either way.
      nodesLocked: useLocalStorage('nodesLocked', false),
      // Tablet layout: collapses the sidebar to give the map full width. A standing layout
      // preference (like activeBasemap/terrainEnabled), not transient UI state, so it's persisted.
      sidebarCollapsed: useLocalStorage('sidebarCollapsed', false),
      // Measure tool: committed vertices [lng,lat], plus the live cursor that draws the rubber-band
      // preview segment out to the pointer.
      measureActive: false,
      measurePoints: [] as [number, number][],
      measureCursor: null as [number, number] | null,
      locationSearchActive: false,
      // nodeId set => the node-variant menu (delete/share); unset => the empty-map variant (add/copy).
      contextMenu: null as { x: number; y: number; lat: number; lng: number; nodeId?: string } | null,
      // shared / global params (per-node radio lives on the nodes themselves)
      splatParams: useLocalStorage('splatParams', {
        lora: {
          preset: DEFAULT_PRESET,
          spreadingFactor: MESHTASTIC_PRESETS[DEFAULT_PRESET].spreadingFactor,
          bandwidthKhz: MESHTASTIC_PRESETS[DEFAULT_PRESET].bandwidthKhz,
          frequencyMhz: undefined as number | undefined
        },
        environment: {
          radio_climate: 'continental_temperate',
          polarization: 'vertical',
          clutter_height: 1.0,
          ground_dielectric: 15.0,
          ground_conductivity: 0.005,
          atmosphere_bending: 301.0
        },
        simulation: {
          situation_fraction: 95.0,
          time_fraction: 95.0,
          simulation_extent: 30.0,
          filter_radio_horizon: true,
          max_link_distance_km: 0, // off by default; applies to "Compute all" only
          quality: 'balanced',
          overlay_max_texture: 4096
        },
        display: {
          color_scale: 'plasma',
          min_dbm: -130.0,
          max_dbm: -80.0,
          overlay_transparency: 50
        }
      }, { mergeDefaults: true }) // merge so previously-stored params gain new keys (e.g. lora)
    }
  },
  getters: {
    // The basemaps shown in the switcher. The NZ aerial (LINZ) basemap is NZ-only, so it's hidden
    // unless the user opts in (nzBasemapEnabled) — the source/layer always exist in the style; this
    // only gates whether its button appears.
    availableBasemaps(state) {
      return state.nzBasemapEnabled ? BASEMAPS : BASEMAPS.filter((b) => b.id !== 'linz-aerial');
    },
    // Built-in (LINZ) rows merged with user-added ones, in display order — the single list the
    // settings UI shows and the only thing terrain/sim overlay resolution needs to read. Builtins'
    // enabled state lives separately (builtinProviderEnabled, keyed by id) since their urlTemplate/name
    // always come fresh from demTiles.ts rather than being frozen into a persisted provider object.
    allDemProviders(state): DemProvider[] {
      const builtins = builtinDemProviders().map((p) => ({ ...p, enabled: state.builtinProviderEnabled[p.id] ?? false }));
      return [...builtins, ...state.customDemProviders];
    },
    selectedNode(state): Node | undefined {
      return state.nodes.find((n) => n.id === state.selectedNodeId) ?? state.nodes[0];
    },
    // Ground size (m) of one coverage-overlay cell for the current quality/range/texture-cap settings:
    // (2·radiusM) / renderGrid, the exact width the user sees as a draped square. Surfaced in the
    // Simulation panel so the cell size is explicit instead of implied by the quality label.
    coverageCellMeters(state): number {
      const radiusM = Math.min(100000, state.splatParams.simulation.simulation_extent * 1000);
      const preset = (state.splatParams.simulation.quality ?? 'balanced') as keyof typeof COVERAGE_PRESETS;
      const cap = effectiveTextureCap(state.splatParams.simulation.overlay_max_texture);
      return (2 * radiusM) / coverageGridSize(radiusM, preset, cap);
    },
    // Effective on-map visibility for a node: hidden if its own `hidden` flag is set OR its folder's
    // is. The folder flag is an override that leaves the per-node flag untouched, so showing the
    // folder again restores each node's prior state. Returned as a predicate so callers test any node
    // reactively (templates, renderNodeMarkers, visibleLinks). Rebuilds the hidden-folder set per
    // access — cheap at this scale, and keeps it reactive on `groups`.
    nodeHidden(state): (node: Node) => boolean {
      const hiddenGroups = new Set(state.groups.filter((g) => g.hidden).map((g) => g.id));
      return (node: Node): boolean =>
        Boolean(node.hidden) || (node.groupId != null && hiddenGroups.has(node.groupId));
    },
    // The 3D links only make sense (and queryTerrainElevation only works) with terrain on, and they
    // can be switched off independently. Gates rendering, click-picking and the 2D-line dimming.
    links3dActive(state): boolean {
      return state.terrainEnabled && state.links3dEnabled;
    },
    // Metres along the measured path. LngLat.distanceTo is a great-circle distance, so no geo
    // dependency is needed.
    measureDistanceM(state): number {
      const pts =
        state.measureCursor && state.measurePoints.length
          ? [...state.measurePoints, state.measureCursor]
          : state.measurePoints;
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        total += new maplibregl.LngLat(pts[i - 1][0], pts[i - 1][1]).distanceTo(
          new maplibregl.LngLat(pts[i][0], pts[i][1])
        );
      }
      return total;
    },
    // The links actually drawn on the map (2D draped lines and 3D air-links both filter through
    // this). A dense mesh shows every node-to-node link, most of them non-viable, which buries the
    // useful ones, so:
    //   - linksSelectedOnly on  → only links touching the selected node show (viable or not);
    //   - linksSelectedOnly off → viable links always show, non-viable ones only for the selected node.
    // Recomputed wherever the selection changes (redrawLinks is called from selectNode/addNode/...).
    visibleLinks(state): LinkResult[] {
      const all = state.matrixResult?.links;
      if (!all) {
        return [];
      }
      const sel = state.selectedNodeId;
      const touchesSelected = (l: LinkResult): boolean => l.a === sel || l.b === sel;
      // Hidden nodes drop off the map entirely — including every link that touches one — so a user can
      // focus on a subset without deleting the rest. A node counts as hidden if its own flag or its
      // folder's is set (nodeHidden). Layered on top of the selected/viable filters below, so it
      // applies in every mode. The matrix itself still spans all nodes, so toggling visibility
      // re-filters instantly without recomputing.
      const isHidden = this.nodeHidden;
      const hidden = new Set(state.nodes.filter((n) => isHidden(n)).map((n) => n.id));
      const shown = (l: LinkResult): boolean => !hidden.has(l.a) && !hidden.has(l.b);
      // "Hide invalid links" drops every non-viable link, overriding the selected-node exception that
      // would otherwise still show them (both for selected-only and the default view).
      let links: LinkResult[];
      if (state.hideInvalidLinks) {
        links = state.linksSelectedOnly
          ? all.filter((l) => l.viable && touchesSelected(l) && shown(l))
          : all.filter((l) => l.viable && shown(l));
      } else if (state.linksSelectedOnly) {
        links = all.filter((l) => touchesSelected(l) && shown(l));
      } else {
        links = all.filter((l) => (l.viable || touchesSelected(l)) && shown(l));
      }
      // The link whose profile is open is always shown, even when a filter above would drop it (a
      // non-viable link with "hide invalid" on, an unselected link with "selected only" on, or a
      // hidden endpoint) — the user explicitly opened its profile to inspect the 2D line / 3D beam.
      const pa = state.profileFromId, pb = state.profileToId;
      if (pa && pb) {
        const profiled = all.find((l) => (l.a === pa && l.b === pb) || (l.a === pb && l.b === pa));
        if (profiled && !links.includes(profiled)) {
          links = [...links, profiled];
        }
      }
      return links;
    },
  },
  actions: {
    // Add a node, copying the selected node's radio settings. Drops at `at` when given (the "A"
    // hotkey passes the cursor position), else the map centre.
    addNode(at?: { lat: number; lng: number }) {
      const base = this.selectedNode;
      const pos = at ?? (this.map ? this.map.getCenter() : { lat: DEFAULT_LAT, lng: DEFAULT_LON });
      const node: Node = {
        id: crypto.randomUUID(),
        transmitter: {
          ...(base ? cloneObject(base.transmitter) : defaultTransmitter(this.splatParams.lora?.frequencyMhz)),
          name: randanimalSync(),
          tx_lat: Number(pos.lat.toFixed(6)),
          tx_lon: Number(pos.lng.toFixed(6))
        },
        receiver: base ? cloneObject(base.receiver) : defaultReceiver(),
        // Join the selected node's folder so adding nodes while building out a group keeps them
        // together; undefined (top-level) when nothing is selected or the selection is ungrouped.
        groupId: base?.groupId
      };
      this.nodes.push(node);
      this.selectedNodeId = node.id;
      this.renderNodeMarkers();
      this.redrawLinks(); // selection changed → re-filter the selected node's non-viable links
    },
    // Add a node under the pointer (the "A" hotkey). Falls back to the map centre when the pointer is
    // off the map (lastMapCursor null), matching addNode's default.
    addNodeAtCursor() {
      this.addNode(lastMapCursor ?? undefined);
    },
    selectNode(id: string) {
      this.clearPairTarget(); // a pending pair is relative to the old selection; drop it
      this.selectedNodeId = id;
      this.renderNodeMarkers();
      this.redrawLinks(); // selection drives which non-viable links are visible (see visibleLinks)
      if (this.viewshedEnabled) {
        this.requestViewshed(); // the viewshed is for the selected node — recompute for the new one
      }
    },
    toggleNodesLock() {
      this.nodesLocked = !this.nodesLocked;
      this.renderNodeMarkers(); // re-render flips setDraggable on every existing marker
    },
    toggleSidebarCollapsed() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },
    toggleMeasure() {
      this.measureActive = !this.measureActive;
      if (!this.measureActive) {
        this.measurePoints = [];
        this.measureCursor = null;
        measureFinished = false;
        measureDragIndex = -1;
      }
      this.applyMeasureMode();
    },
    toggleLocationSearch() {
      this.locationSearchActive = !this.locationSearchActive;
      locationSearchControl?.setActive(this.locationSearchActive);
    },
    // Explicit close, not toggle — dismissal paths must never re-open the panel.
    closeLocationSearch() {
      this.locationSearchActive = false;
      locationSearchControl?.setActive(false);
    },
    // Fly the camera to a geocoded result; zoom only goes up (never zooms out from a closer view).
    flyToLocation(lat: number, lon: number, zoom = 17) {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom) });
    },
    openContextMenu(x: number, y: number, lat: number, lng: number, nodeId?: string) {
      this.contextMenu = { x, y, lat, lng, nodeId };
    },
    closeContextMenu() {
      this.contextMenu = null;
    },
    // Clear the line without leaving the tool (vs toggleMeasure, which exits).
    clearMeasure() {
      this.measurePoints = [];
      this.measureCursor = null;
      measureFinished = false;
      this.redrawMeasure();
    },
    applyMeasureMode() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      if (this.measureActive) {
        map.getCanvas().style.cursor = 'crosshair';
        // so the double-click-to-finish gesture doesn't also zoom
        map.doubleClickZoom.disable();
      } else {
        map.getCanvas().style.cursor = '';
        map.doubleClickZoom.enable();
      }
      measureControl?.setActive(this.measureActive);
      this.redrawMeasure();
    },
    redrawMeasure() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map || !map.getSource('measure-line')) {
        return;
      }
      const linePts =
        this.measureCursor && this.measurePoints.length
          ? [...this.measurePoints, this.measureCursor]
          : this.measurePoints;
      const lineFc =
        linePts.length >= 2
          ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: linePts }, properties: {} }] }
          : EMPTY_FC;
      const ptFc = {
        type: 'FeatureCollection',
        // index lets the mousedown handler tell which vertex was grabbed for dragging.
        features: this.measurePoints.map((c, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { index: i } })),
      };
      (map.getSource('measure-line') as maplibregl.GeoJSONSource).setData(lineFc as any);
      (map.getSource('measure-pts') as maplibregl.GeoJSONSource).setData(ptFc as any);
    },
    // Hide/show a single node from the map. The node stays in the list (and editable / selectable),
    // but its marker and every link touching it disappear — see renderNodeMarkers + visibleLinks.
    toggleNodeVisibility(id: string) {
      const node = this.nodes.find((n) => n.id === id);
      if (!node) {
        return;
      }
      node.hidden = !node.hidden;
      this.renderNodeMarkers(); // drop or restore this node's marker
      this.redrawLinks();       // re-filter the links touching it (2D + 3D)
    },
    // Record a node's position BEFORE a coordinate change so Ctrl+Z can restore it. Called from the
    // marker dragstart (pre-drag position) and the panel lat/lon edit commit (pre-edit position).
    pushNodeMove(nodeId: string, lat: number, lon: number) {
      this.pushNodeHistory({ type: 'move', nodeId, lat, lon });
    },
    // Shared push for the Ctrl+Z stack (moves + deletes), capping its size.
    pushNodeHistory(entry: NodeHistoryEntry) {
      this.nodeHistory.push(entry);
      if (this.nodeHistory.length > NODE_HISTORY_LIMIT) {
        this.nodeHistory.shift();
      }
    },
    // Undo the most recent node change (move or delete). A move entry whose node was since deleted is
    // discarded and the next entry is tried. The coordinate/array write triggers the nodes watcher
    // (initMap), which refreshes markers/links/matrix/viewshed/profile; redrawPairLink keeps an active
    // pair preview attached. Returns whether something was actually undone, so the key handler can
    // preventDefault.
    undoLastNodeChange(): boolean {
      while (this.nodeHistory.length) {
        const entry = this.nodeHistory.pop()!;
        if (entry.type === 'move') {
          const node = this.nodes.find((n) => n.id === entry.nodeId);
          if (!node) {
            continue; // node deleted since this move was recorded — skip it
          }
          node.transmitter.tx_lat = entry.lat;
          node.transmitter.tx_lon = entry.lon;
          this.redrawPairLink();
          return true;
        }
        // 'delete' — re-insert the node at its original index and restore selection/markers/links.
        const insertIdx = Math.min(entry.index, this.nodes.length);
        this.nodes.splice(insertIdx, 0, entry.node);
        if (entry.wasSelected) {
          this.selectedNodeId = entry.node.id;
        }
        this.renderNodeMarkers();
        this.redrawLinks();
        return true;
      }
      return false;
    },
    // Hide/show the selected node (H shortcut). The node keeps its selection while hidden, so a second
    // press restores it. No-op when nothing is selected.
    toggleSelectedNodeVisibility() {
      if (this.selectedNodeId) {
        this.toggleNodeVisibility(this.selectedNodeId);
      }
    },
    // Bulk hide/show, behind the node list's "Hide all" / "Show all" buttons. No-op (no redraw) when
    // nothing actually changes, so a redundant click doesn't churn the markers/links. "Show all" also
    // clears every folder-level hide so a hidden folder can't keep its members off the map.
    setAllNodesHidden(hidden: boolean) {
      let changed = false;
      for (const node of this.nodes) {
        if (Boolean(node.hidden) !== hidden) {
          node.hidden = hidden;
          changed = true;
        }
      }
      if (!hidden) {
        for (const group of this.groups) {
          if (group.hidden) {
            group.hidden = false;
            changed = true;
          }
        }
      }
      if (!changed) {
        return;
      }
      this.renderNodeMarkers();
      this.redrawLinks();
    },
    // Push the active preset's frequency onto every existing node (e.g. after switching MeshCore
    // region presets). No-op when the active preset has no frequency (Meshtastic, or Custom).
    applyLoraFrequencyToAllNodes() {
      const freq = this.splatParams.lora?.frequencyMhz;
      if (freq == null) {
        return;
      }
      for (const node of this.nodes) {
        node.transmitter.tx_freq = freq;
      }
    },
    // Create a folder and return its id so the caller can drop the user straight into renaming it.
    // New folders start empty and expanded; nodes join via moveNodeToGroup / drag-and-drop.
    addGroup(name = 'New folder'): string {
      const group: NodeGroup = { id: crypto.randomUUID(), name };
      this.groups.push(group);
      return group.id;
    },
    // Bulk-create nodes from imported MeshCore contacts, all dropped into a single "Imported" folder
    // (reused across re-imports rather than re-created). Rows are already type-filtered and deduped by
    // the import UI; this just builds nodes with default radio params and the name/coords overridden,
    // mirroring addNode. Returns how many were added.
    importContacts(rows: Array<{ name: string; lat: number; lon: number }>): number {
      if (!rows.length) {
        return 0;
      }
      const groupId =
        this.groups.find((g) => g.name === IMPORTED_FOLDER_NAME)?.id ?? this.addGroup(IMPORTED_FOLDER_NAME);
      for (const row of rows) {
        const node: Node = {
          id: crypto.randomUUID(),
          transmitter: {
            ...defaultTransmitter(),
            name: row.name,
            tx_lat: Number(row.lat.toFixed(6)),
            tx_lon: Number(row.lon.toFixed(6))
          },
          receiver: defaultReceiver(),
          groupId
        };
        this.nodes.push(node);
      }
      this.renderNodeMarkers();
      this.redrawLinks();
      return rows.length;
    },
    // Bulk-create nodes from a public-map sync (MeshCore/MeshMapper), all dropped into a single
    // "Public MeshCore" folder (reused across re-syncs). Rows are already clipped to the view and
    // deduped by the sync orchestrator (src/sources). Mirrors importContacts, but carries the node's
    // real frequency when the source provided one, and stores its public key (meshKey) for exact
    // re-sync/cross-source dedupe. Returns how many were added.
    importPublicMapNodes(
      rows: Array<{ name: string; lat: number; lon: number; freq: number | null; meshKey: string | null }>
    ): number {
      if (!rows.length) {
        return 0;
      }
      const groupId =
        this.groups.find((g) => g.name === PUBLIC_MAP_FOLDER_NAME)?.id ?? this.addGroup(PUBLIC_MAP_FOLDER_NAME);
      for (const row of rows) {
        const transmitter = {
          ...defaultTransmitter(),
          name: row.name,
          tx_lat: Number(row.lat.toFixed(6)),
          tx_lon: Number(row.lon.toFixed(6))
        };
        if (row.freq != null && Number.isFinite(row.freq)) {
          transmitter.tx_freq = row.freq;
        }
        const node: Node = {
          id: crypto.randomUUID(),
          transmitter,
          receiver: defaultReceiver(),
          groupId,
          ...(row.meshKey ? { meshKey: row.meshKey } : {})
        };
        this.nodes.push(node);
      }
      this.renderNodeMarkers();
      this.redrawLinks();
      return rows.length;
    },
    // Parse a share link (#s=<base64url>) from the URL on startup into `incomingShare` (pending, not
    // yet applied — the banner confirms before mutating the saved map). The hash is stripped
    // immediately, whether or not it decoded, so a reload or HMR remount never re-triggers. Called
    // once at the top of initMap; needs no map.
    parseShareLink() {
      const match = location.hash.match(/^#s=(.+)$/);
      if (!match) {
        return;
      }
      const payload = decodeShare(match[1]);
      history.replaceState(null, '', location.pathname + location.search);
      if (payload) {
        this.incomingShare = payload;
      }
    },
    // Apply the pending shared node(s) (the banner's "Add"): add each (deduped by name+coords against
    // the existing nodes, same key the import uses, so reopening a link can't pile up duplicates),
    // select the first, frame them, and for a link share compute the profile between the pair.
    applyIncomingShare() {
      const payload = this.incomingShare;
      if (!payload) {
        return;
      }
      const dt = defaultTransmitter();
      const dr = defaultReceiver();
      const fin = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
      // A folder share carries the folder name: drop new nodes into a folder of that name (reused if it
      // already exists, like the contacts import), so the recipient gets them grouped.
      const groupId = payload.g
        ? (this.groups.find((gp) => gp.name === payload.g)?.id ?? this.addGroup(payload.g))
        : undefined;
      const ids: string[] = [];
      for (const sn of payload.n) {
        const lat = Number(sn.lat.toFixed(6));
        const lon = Number(sn.lon.toFixed(6));
        const existing = this.nodes.find(
          (n) =>
            n.transmitter.name === sn.name &&
            Number(n.transmitter.tx_lat.toFixed(6)) === lat &&
            Number(n.transmitter.tx_lon.toFixed(6)) === lon
        );
        if (existing) {
          ids.push(existing.id);
          continue;
        }
        const node: Node = {
          id: crypto.randomUUID(),
          transmitter: {
            name: sn.name,
            tx_lat: lat,
            tx_lon: lon,
            tx_power: fin(sn.txp, dt.tx_power),
            tx_freq: fin(sn.txf, dt.tx_freq),
            tx_height: fin(sn.txh, dt.tx_height),
            tx_gain: fin(sn.txg, dt.tx_gain),
          },
          receiver: {
            rx_sensitivity: fin(sn.rxs, dr.rx_sensitivity),
            rx_height: fin(sn.rxh, dr.rx_height),
            rx_gain: fin(sn.rxg, dr.rx_gain),
            rx_loss: fin(sn.rxl, dr.rx_loss),
          },
          groupId,
        };
        this.nodes.push(node);
        ids.push(node.id);
      }
      this.incomingShare = null;
      if (!ids.length) {
        return;
      }
      this.selectedNodeId = ids[0];
      this.renderNodeMarkers();
      this.redrawLinks();
      if (payload.t === 'link' && ids.length >= 2) {
        this.fitNodes([ids[0], ids[1]]);
        this.runProfile(ids[0], ids[1]); // opens the bottom profile strip for the shared pair
      } else {
        this.fitNodes(ids); // a site share: frame every added/matched node
      }
    },
    // Dismiss the pending share without touching the saved map (the hash was already stripped on parse).
    dismissIncomingShare() {
      this.incomingShare = null;
    },
    // Frame the map on one or more nodes: fly to a single node (keeping any closer zoom), or fit the
    // bounds of several. Used when applying a shared link.
    fitNodes(ids: string[]) {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      const pts = ids
        .map((id) => this.nodes.find((n) => n.id === id))
        .filter((n): n is Node => Boolean(n))
        .map((n) => [n.transmitter.tx_lon, n.transmitter.tx_lat] as [number, number]);
      if (!pts.length) {
        return;
      }
      if (pts.length === 1) {
        map.flyTo({ center: pts[0], zoom: Math.max(map.getZoom(), 12) });
        return;
      }
      const bounds = new maplibregl.LngLatBounds(pts[0], pts[0]);
      for (const p of pts) {
        bounds.extend(p);
      }
      // Bottom padding leaves room for the docked profile strip that a link share opens.
      map.fitBounds(bounds, { padding: { top: 60, right: 60, bottom: 160, left: 60 }, maxZoom: 14, duration: 800 });
    },
    renameGroup(id: string, name: string) {
      const group = this.groups.find((g) => g.id === id);
      if (group) {
        group.name = name;
      }
    },
    // Set (or clear, with null) the folder's map colour and re-style its pins in place.
    setGroupColor(id: string, color: string | null) {
      const group = this.groups.find((g) => g.id === id);
      if (!group) {
        return;
      }
      group.color = color ?? undefined;
      this.renderNodeMarkers();
    },
    // List-only toggle: collapse/expand a folder in the panel. Doesn't touch the map.
    toggleGroupCollapsed(id: string) {
      const group = this.groups.find((g) => g.id === id);
      if (group) {
        group.collapsed = !group.collapsed;
      }
    },
    // Hide/show every member of a folder at once. Flips the folder's own flag (which overrides each
    // member's per-node flag in nodeHidden) rather than the nodes', so the members' individual
    // visibility is preserved and restored when the folder is shown again.
    toggleGroupVisibility(id: string) {
      const group = this.groups.find((g) => g.id === id);
      if (!group) {
        return;
      }
      group.hidden = !group.hidden;
      this.renderNodeMarkers();
      this.redrawLinks();
    },
    // Delete a folder. Its member nodes are kept — they fall back to ungrouped (top-level), not
    // deleted. Only needs a redraw if the folder was hiding members, which now reappear.
    deleteGroup(id: string) {
      const idx = this.groups.findIndex((g) => g.id === id);
      if (idx === -1) {
        return;
      }
      const wasHiding = Boolean(this.groups[idx].hidden);
      this.groups.splice(idx, 1);
      for (const node of this.nodes) {
        if (node.groupId === id) {
          node.groupId = undefined;
        }
      }
      if (wasHiding) {
        this.renderNodeMarkers();
        this.redrawLinks();
      }
    },
    // Move a node into a folder (groupId) or to the top level (null), optionally inserting it before
    // another node so drag-and-drop can both regroup and reorder in one call. Order lives in the flat
    // `nodes` array; the panel renders each folder by filtering that array, so contiguity isn't
    // required — appending to the array end still renders as the folder's last child. Always redraws:
    // crossing a hidden-folder boundary can flip the node's effective visibility, and a reorder is
    // cheap to reconcile.
    moveNodeToGroup(nodeId: string, groupId: string | null, beforeNodeId: string | null = null) {
      const fromIdx = this.nodes.findIndex((n) => n.id === nodeId);
      if (fromIdx === -1 || nodeId === beforeNodeId) {
        return;
      }
      const [node] = this.nodes.splice(fromIdx, 1);
      node.groupId = groupId ?? undefined;
      let insertIdx = this.nodes.length;
      if (beforeNodeId) {
        const at = this.nodes.findIndex((n) => n.id === beforeNodeId);
        if (at !== -1) {
          insertIdx = at;
        }
      }
      this.nodes.splice(insertIdx, 0, node);
      this.renderNodeMarkers();
      this.redrawLinks();
    },
    // Reorder a folder, moving it before another (or to the end when beforeGroupId is null). Purely a
    // list reordering — folder membership and map state are unaffected, so no redraw.
    moveGroup(groupId: string, beforeGroupId: string | null) {
      const fromIdx = this.groups.findIndex((g) => g.id === groupId);
      if (fromIdx === -1 || groupId === beforeGroupId) {
        return;
      }
      const [group] = this.groups.splice(fromIdx, 1);
      let insertIdx = this.groups.length;
      if (beforeGroupId) {
        const at = this.groups.findIndex((g) => g.id === beforeGroupId);
        if (at !== -1) {
          insertIdx = at;
        }
      }
      this.groups.splice(insertIdx, 0, group);
    },
    deleteNode(id: string) {
      const idx = this.nodes.findIndex((n) => n.id === id);
      if (idx === -1) {
        return;
      }
      const wasSelected = this.selectedNodeId === id;
      const [node] = this.nodes.splice(idx, 1);
      this.pushNodeHistory({ type: 'delete', node, index: idx, wasSelected });
      if (this.pairTargetId === id) {
        this.clearPairTarget(); // the pending pair's target just vanished
      }
      if (this.contextMenu?.nodeId === id) {
        this.closeContextMenu(); // the open menu's target just vanished
      }
      if (wasSelected) {
        this.selectedNodeId = this.nodes[0]?.id ?? null;
      }
      this.renderNodeMarkers();
      this.redrawLinks(); // drop the deleted node's links and re-filter for the new selection
    },
    updateNodeCoords(id: string, lat: number, lon: number) {
      const node = this.nodes.find((n) => n.id === id);
      if (!node) {
        return;
      }
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      node.transmitter.tx_lat = lat;
      node.transmitter.tx_lon = lon;
    },
    renderNodeMarkers() {
      // Markers attach to the map container, not the style, so they work before 'load'.
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      // Remove markers for nodes that no longer exist or have been hidden (by their own flag or their
      // folder's — see nodeHidden).
      const isHidden = this.nodeHidden;
      for (const id of Object.keys(this.nodeMarkers)) {
        const node = this.nodes.find((n) => n.id === id);
        if (!node || isHidden(node)) {
          this.nodeMarkers[id].remove();
          delete this.nodeMarkers[id];
          attachedMarkers.delete(id);
        }
      }
      const selectedId = this.selectedNode?.id;
      // Folder → colour, so each pin can take its folder's colour without a per-node array scan.
      const groupColors = new Map(this.groups.map((g) => [g.id, g.color]));
      for (const node of this.nodes) {
        if (isHidden(node)) {
          continue; // hidden nodes have no marker — they're excluded from the map and all links
        }
        const lngLat: [number, number] = [node.transmitter.tx_lon, node.transmitter.tx_lat];
        const selected = node.id === selectedId;
        const color = node.groupId ? groupColors.get(node.groupId) : undefined;
        let marker = this.nodeMarkers[node.id];
        if (!marker) {
          const el = makePinElement(selected, node.transmitter.name, color);
          // MapLibre's marker drag is bound to the map's mousedown and fires on ANY button, so a
          // right-click meant to rotate the map would instead drag the node. Swallow non-left
          // mousedowns before they bubble to the map container so only left-drag moves a pin.
          el.addEventListener('mousedown', (e) => {
            if (e.button === 2) {
              // stopPropagation below keeps this off the map-level mousedown, so record it here too —
              // covers a drag-off-the-marker release landing on open map.
              const rect = (this.map as maplibregl.Map).getContainer().getBoundingClientRect();
              rightMouseDownPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            }
            if (e.button !== 0) {
              e.stopPropagation();
            }
          });
          // stopPropagation so the map-level 'contextmenu' handler doesn't also open the empty-map menu.
          el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // clientX/Y are viewport-relative; convert to map-container-relative to match e.point elsewhere.
            const rect = (this.map as maplibregl.Map).getContainer().getBoundingClientRect();
            this.openContextMenu(e.clientX - rect.left, e.clientY - rect.top, node.transmitter.tx_lat, node.transmitter.tx_lon, node.id);
          });
          // MapLibre markers have no click event; listen on the element. stopPropagation keeps the
          // pin click from also firing the map click used by "Set with map".
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.shiftKey && this.selectedNodeId && this.selectedNodeId !== node.id) {
              // Shift-pick a second node: preview the ground link and offer to compute it, without
              // moving the primary selection. stopImmediatePropagation suppresses the marker's own
              // name-popup toggle (registered later via setPopup) so only our pair popup shows.
              e.stopImmediatePropagation();
              this.setPairTarget(node.id);
            } else {
              this.selectNode(node.id);
            }
          });
          marker = markRaw(
            new maplibregl.Marker({ element: el, draggable: !this.nodesLocked, anchor: 'bottom' })
              .setLngLat(lngLat)
              // setText (not setHTML) so a node name can't inject HTML.
              .setPopup(new maplibregl.Popup({ offset: 30 }).setText(node.transmitter.name))
            // no .addTo(map): cullMarkers() attaches only the in-view subset (see attachedMarkers).
          );
          marker.on('dragstart', () => {
            this.dragging = true;
            // Record the pre-drag position for Ctrl+Z. dragstart fires only on a real drag (not a
            // plain click), and before any 'drag' event mutates the coords, so this is the true origin.
            this.pushNodeMove(node.id, node.transmitter.tx_lat, node.transmitter.tx_lon);
          });
          marker.on('drag', () => {
            // Live viewshed: track the selected node continuously while it's dragged (throttled to one
            // recompute per frame). Other modes ignore mid-drag movement; dragend handles the rest.
            if (this.viewshedEnabled && this.viewshedLive && node.id === this.selectedNodeId) {
              const { lng, lat } = marker.getLngLat();
              this.updateNodeCoords(node.id, lat, lng);
              this.requestViewshedLive();
            }
          });
          marker.on('dragend', () => {
            const { lng, lat } = marker.getLngLat();
            this.updateNodeCoords(node.id, lat, lng);
            this.dragging = false;
            this.redrawPairLink(); // keep the preview attached if this node is in the pending pair
            // Recompute the viewshed at full detail for the final position (covers both live — which
            // ran coarse mid-drag — and move-end mode). dragging is now false, so this is full quality.
            if (this.viewshedEnabled && node.id === this.selectedNodeId) {
              if (viewshedRaf) {
                cancelAnimationFrame(viewshedRaf);
                viewshedRaf = 0;
              }
              this.computeViewshed();
            }
          });
          this.nodeMarkers[node.id] = marker;
        } else {
          marker.setLngLat(lngLat);
          marker.setDraggable(!this.nodesLocked); // re-render is the only path that toggles the lock
          stylePinElement(marker.getElement(), selected, node.transmitter.name, color); // re-style in place; don't churn markers
          marker.getPopup()?.setText(node.transmitter.name);
        }
      }
      this.cullMarkers(); // attach only the in-view subset of the now up-to-date marker cache
    },
    // Attach only markers near the current view; detach the rest. MapLibre rewrites every attached
    // marker's DOM transform on each pan frame, so leaving 300 off-screen pins attached janks panning;
    // detached pins cost nothing and their cached Marker (element/popup/handlers) survives addTo/remove.
    // Tests padded lng/lat bounds, not project(): a point behind the camera or past the horizon
    // (pitch/terrain) can project to a misleading on-screen pixel, but bounds containment stays correct.
    cullMarkers() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      // Pad the visible bounds by half its span each side, so a pan reveals already-attached neighbours
      // before the next moveend culls — no visible pop-in at normal pan speeds.
      const b = map.getBounds();
      const padW = (b.getEast() - b.getWest()) * 0.5;
      const padH = (b.getNorth() - b.getSouth()) * 0.5;
      const west = b.getWest() - padW, east = b.getEast() + padW;
      const south = b.getSouth() - padH, north = b.getNorth() + padH;
      const wraps = west > east; // view straddling ±180
      const inView = (lng: number, lat: number): boolean =>
        lat >= south && lat <= north &&
        (wraps ? (lng >= west || lng <= east) : (lng >= west && lng <= east));

      // Always keep the selected node attached: it's the viewshed/link focus and the only live-drag
      // target, so detaching its element under the pointer would abort a drag.
      const selectedId = this.selectedNode?.id;

      for (const [id, marker] of Object.entries(this.nodeMarkers)) {
        const ll = marker.getLngLat();
        const keep = id === selectedId || inView(ll.lng, ll.lat);
        const attached = attachedMarkers.has(id);
        if (keep && !attached) {
          marker.addTo(map);
          attachedMarkers.add(id);
        } else if (!keep && attached) {
          marker.getPopup()?.remove(); // don't leave a name popup floating after the pin detaches
          marker.remove();
          attachedMarkers.delete(id);
        }
      }
    },
    toggleSiteVisibility(index: number) {
      const site = this.localSites[index];
      if (!site) {
        return;
      }
      site.visible = site.visible === false;
      const id = 'cov-' + site.taskId;
      // Keep the source resident (cheaper than re-uploading the texture); just toggle the layer.
      if (this.map?.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', site.visible ? 'visible' : 'none');
      }
    },
    removeSite(index: number) {
      const site = this.localSites[index];
      if (!site) {
        return;
      }
      const id = 'cov-' + site.taskId;
      if (this.map?.getLayer(id)) {
        this.map.removeLayer(id);
      }
      if (this.map?.getSource(id)) {
        this.map.removeSource(id);
      }
      this.localSites.splice(index, 1);
    },
    redrawSites() {
      const map = this.map as maplibregl.Map | undefined;
      // Gate on an overlay layer existing (setupOverlays has run → the style is mutable), NOT
      // isStyleLoaded(): the latter reads false while source tiles stream, and the slow simulation-
      // terrain tiles can keep it false long after a coverage run finishes — which would drop the
      // coverage overlay entirely and never re-add it. addSource/addLayer only need the style loaded,
      // not its tiles. See [[maplibre-isstyleloaded]].
      if (!map || !map.getLayer(COVERAGE_BEFORE)) {
        return; // re-run from the 'load' handler once overlays exist
      }
      const opacity = 1 - (this.splatParams.display.overlay_transparency ?? 0) / 100;
      for (const site of this.localSites) {
        if (!site.image || !site.coords) {
          continue; // not parsed yet
        }
        const id = 'cov-' + site.taskId;
        if (!map.getSource(id)) {
          map.addSource(id, { type: 'canvas', canvas: site.image, coordinates: site.coords, animate: false } as any);
          map.addLayer(
            {
              id,
              type: 'raster',
              source: id,
              paint: { 'raster-opacity': opacity, 'raster-resampling': 'nearest' },
            } as any,
            map.getLayer(COVERAGE_BEFORE) ? COVERAGE_BEFORE : undefined
          );
        }
        map.setLayoutProperty(id, 'visibility', site.visible === false ? 'none' : 'visible');
      }
    },
    // Live-apply the global transparency slider to every coverage layer (watched in initMap).
    applyCoverageOpacity() {
      const map = this.map as maplibregl.Map | undefined;
      // Per-layer getLayer() guards each setPaintProperty below, so only a null map needs gating here
      // (not isStyleLoaded — see [[maplibre-isstyleloaded]]).
      if (!map) {
        return;
      }
      const opacity = 1 - (this.splatParams.display.overlay_transparency ?? 0) / 100;
      for (const site of this.localSites) {
        const id = 'cov-' + site.taskId;
        if (map.getLayer(id)) {
          map.setPaintProperty(id, 'raster-opacity', opacity);
        }
      }
      // The relay heatmap shares the same draped-raster treatment, so the slider drives it too.
      if (map.getLayer('relay-cov')) {
        map.setPaintProperty('relay-cov', 'raster-opacity', opacity);
      }
    },
    toggleViewshed() {
      this.viewshedEnabled = !this.viewshedEnabled;
      if (this.viewshedEnabled) {
        trackEvent('viewshed-enable');
        // Cheap synchronous gate so the panel doesn't flash the enabled controls before computeViewshed's
        // async engine-acquisition settles; computeViewshed below re-checks authoritatively either way.
        if (!ViewshedEngine.isSupported() && !Webgl2ViewshedEngine.isSupported()) {
          this.viewshedState = 'unsupported'; // panel shows the notice; nothing else to do
          return;
        }
        this.computeViewshed();
      } else {
        this.clearViewshed();
      }
    },
    // Toggle live (recompute every frame while dragging) vs on-move-end. The drag handler reads the
    // flag live, so no recompute is needed here — only the next drag changes behaviour.
    toggleViewshedLive() {
      this.viewshedLive = !this.viewshedLive;
    },
    setViewshedRadiusKm(km: number) {
      this.viewshedRadiusKm = Math.max(1, Math.min(30, km));
      this.requestViewshed();
    },
    setViewshedTargetHeight(m: number) {
      this.viewshedTargetHeight = Math.max(0, Math.min(100, m));
      this.requestViewshed();
    },
    // Live-apply the opacity slider to the existing layer; no recompute (it's a paint property).
    setViewshedOpacity(v: number) {
      this.viewshedOpacity = Math.max(0, Math.min(1, v));
      const map = this.map as maplibregl.Map | undefined;
      if (map && map.getLayer(VIEWSHED_ID)) {
        map.setPaintProperty(VIEWSHED_ID, 'raster-opacity', this.viewshedOpacity);
      }
    },
    // Debounced recompute for parameter changes / manual node edits (rapid slider/keystroke bursts).
    requestViewshed() {
      if (!this.viewshedEnabled || this.viewshedState === 'unsupported') {
        return;
      }
      if (viewshedTimer) {
        clearTimeout(viewshedTimer);
      }
      viewshedTimer = setTimeout(() => {
        viewshedTimer = null;
        this.computeViewshed();
      }, 120);
    },
    // Throttled recompute for live dragging: at most one in flight per animation frame.
    requestViewshedLive() {
      if (!this.viewshedEnabled || !this.viewshedLive || this.viewshedState === 'unsupported') {
        return;
      }
      if (viewshedRaf) {
        return;
      }
      viewshedRaf = requestAnimationFrame(() => {
        viewshedRaf = 0;
        this.computeViewshed();
      });
    },
    clearViewshed() {
      if (viewshedRaf) {
        cancelAnimationFrame(viewshedRaf);
        viewshedRaf = 0;
      }
      if (viewshedTimer) {
        clearTimeout(viewshedTimer);
        viewshedTimer = null;
      }
      viewshedResultCanvas = null;
      viewshedCoords = null;
      this.viewshedProgress = null;
      const map = this.map as maplibregl.Map | undefined;
      if (map) {
        if (map.getLayer(VIEWSHED_ID)) {
          map.removeLayer(VIEWSHED_ID);
        }
        if (map.getSource(VIEWSHED_ID)) {
          map.removeSource(VIEWSHED_ID);
        }
      }
      if (this.viewshedState !== 'unsupported') {
        this.viewshedState = 'idle';
      }
    },
    // Drape the latest computed footprint as a canvas source + raster layer. Mirrors redrawSites, but
    // the result canvas is already web-mercator tile-aligned (no mercatorWarp needed); still runs through
    // fitCoverageCanvas to dodge the square-power-of-two black-texture bug. Gate on the overlay slot
    // existing (not isStyleLoaded — see [[maplibre-isstyleloaded]]).
    renderViewshed() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map || !map.getLayer(COVERAGE_BEFORE)) {
        return; // overlays not built yet; the 'load' handler re-runs compute/render
      }
      if (map.getLayer(VIEWSHED_ID)) {
        map.removeLayer(VIEWSHED_ID);
      }
      if (map.getSource(VIEWSHED_ID)) {
        map.removeSource(VIEWSHED_ID);
      }
      if (!this.viewshedEnabled || !viewshedResultCanvas || !viewshedCoords) {
        return;
      }
      const canvas = fitCoverageCanvas(viewshedResultCanvas);
      map.addSource(VIEWSHED_ID, { type: 'canvas', canvas, coordinates: viewshedCoords, animate: false } as any);
      map.addLayer(
        {
          id: VIEWSHED_ID,
          type: 'raster',
          source: VIEWSHED_ID,
          paint: { 'raster-opacity': this.viewshedOpacity, 'raster-resampling': 'nearest' },
        } as any,
        map.getLayer(COVERAGE_BEFORE) ? COVERAGE_BEFORE : undefined,
      );
    },
    // Run one GPU LOS pass over `hm` and drape it. Serialised through viewshedPassPromise so the
    // progressive (mid-fetch) passes and the final pass never overlap on the engine's shared GPU
    // buffers: skipIfBusy drops a progressive frame when a pass is already running, while the final
    // pass (skipIfBusy=false) waits for the in-flight one and then runs, so the complete result lands.
    async _viewshedRenderPass(hm: Heightmap, node: Node, cap: number, skipIfBusy: boolean) {
      if (!viewshedEngine) {
        return;
      }
      if (viewshedPassPromise) {
        if (skipIfBusy) {
          return; // a pass is in flight; drop this intermediate frame
        }
        await viewshedPassPromise.catch(() => {});
      }
      // Output grid = mosaic, capped on the long edge (keep aspect so pixels stay ~square). The cap is
      // what controls how detailed the result is: at the full mosaic resolution (the move-end pass) one
      // output cell == one terrain post, so a high-res surface like LINZ DSM paints crisp, not blocky.
      const scale = Math.min(1, cap / Math.max(hm.width, hm.height));
      const outW = Math.max(1, Math.round(hm.width * scale));
      const outH = Math.max(1, Math.round(hm.height * scale));
      // One ray-march step per output pixel (stride ≈ 1 px) so the LOS sampling density tracks the
      // output resolution: a finer grid is also marched more finely, rather than a fixed step budget
      // that would under-sample (skip thin ridges) once the grid outgrows it.
      const maxSteps = Math.max(outW, outH);
      const run = (async () => {
        const result = await viewshedEngine!.compute({
          heightmap: hm,
          obsLon: node.transmitter.tx_lon,
          obsLat: node.transmitter.tx_lat,
          txHeight: node.transmitter.tx_height,
          targetHeight: Math.max(0, this.viewshedTargetHeight),
          outW,
          outH,
          maxSteps,
        });
        viewshedResultCanvas = markRaw(result.canvas);
        viewshedCoords = result.coords;
        this.renderViewshed();
      })();
      const chained: Promise<void> = run.finally(() => {
        if (viewshedPassPromise === chained) {
          viewshedPassPromise = null;
        }
      });
      viewshedPassPromise = chained;
      await chained;
    },
    // Fetch the heightmap (from the map's active terrain source) and run the WebGPU LOS pass, then
    // drape the result. Never throws out — a failure leaves the map untouched and flags the error.
    // Coalesces overlapping runs (a drag can fire faster than a compute finishes): the latest request
    // wins via the dirty flag.
    async computeViewshed() {
      if (!this.viewshedEnabled || !this.map || this.viewshedState === 'unsupported') {
        return;
      }
      const node = this.selectedNode;
      if (!node) {
        this.clearViewshed();
        return;
      }
      if (viewshedComputing) {
        viewshedDirty = true; // a run is in flight; re-run once with the latest position when it ends
        return;
      }
      viewshedComputing = true;
      this.viewshedState = 'computing';
      try {
        if (!viewshedEngine) {
          viewshedEngine = await acquireViewshedEngine();
          if (!viewshedEngine) {
            this.viewshedState = 'unsupported';
            return;
          }
        }
        // Resolve the same surface the map draws: the Mapterhorn baseline plus every enabled
        // overlay provider. heightmap.ts can't fetch the map's meshdem:// URL, so it composites from
        // the base template + overlays itself (same underlying tiles → warm HTTP cache as the map).
        const overlays = enabledOverlaySpecs(this.allDemProviders);
        const radiusM = Math.max(1000, Math.min(30000, this.viewshedRadiusKm * 1000));
        // Output-grid long-edge cap, the knob that trades detail for GPU cost (cost ~ outPx² × steps):
        //  - live drag: small, for framerate.
        //  - progressive (mid-fetch refinement): a cheap interim so a slow fetch shows something.
        //  - final (settled) pass: MAX_TEXTURE, so the grid follows the heightmap's own resolution
        //    (1:1 — the mosaic is ≤2048², well under the cap), sharpening the footprint against the
        //    terrain detail the map already shows.
        const live = this.dragging && this.viewshedLive;
        const liveCap = 512;
        const progressiveCap = live ? liveCap : 1024;
        const finalCap = live ? liveCap : MAX_TEXTURE;
        // Fetch at the zoom the map is showing so we reuse its warm tiles (see heightmap.ts); remember
        // it so a moveend only re-fetches when the zoom level actually changes.
        const mapZoom = (this.map as maplibregl.Map).getZoom();
        viewshedLastZoom = Math.round(mapZoom);
        // Fetch the heightmap, rendering progressively as tiles stream in so a slow LINZ fetch fills
        // the view in instead of looking frozen. Each emit re-runs the GPU pass over the mosaic so far;
        // gate until a third of the tiles are in (avoids a misleading all-sea/all-visible flash) and
        // drop frames while a pass is busy. The panel shows the live N/M tile count via viewshedProgress.
        const hm = await getHeightmap(
          {
            urlTemplate: MAPTERHORN_TEMPLATE,
            overlays,
            maxzoom: DEM_MAXZOOM,
            lon: node.transmitter.tx_lon,
            lat: node.transmitter.tx_lat,
            radiusM,
            mapZoom,
          },
          (p) => {
            this.viewshedProgress = { loaded: p.loaded, total: p.total };
            if (p.loaded / p.total >= 0.33) {
              // Fire-and-forget; swallow errors here (the final pass below surfaces any real failure).
              void this._viewshedRenderPass(p.hm, node, progressiveCap, true).catch(() => {});
            }
          },
        );
        this.viewshedProgress = null;
        await this._viewshedRenderPass(hm, node, finalCap, false); // final pass over the complete mosaic
        this.viewshedState = 'ready';
      } catch (e) {
        console.error('viewshed compute failed', e);
        this.viewshedState = 'error';
      } finally {
        viewshedComputing = false;
        this.viewshedProgress = null;
        if (viewshedDirty && this.viewshedEnabled) {
          viewshedDirty = false;
          this.computeViewshed(); // run once more for the position that arrived mid-compute
        }
      }
    },
    destroyMap() {
      for (const stop of watchStops) {
        stop();
      }
      watchStops = [];
      if (!this.map) {
        return;
      }
      // map.remove() releases the WebGL context and tears down all DOM markers + event handlers —
      // required before a remount (Vite HMR / navigation) so the GL context and listeners can't leak.
      // It also calls the 3D layer's onRemove (disposing its three.js GL resources); just drop our
      // refs and cancel any pending rebuild so they don't fire against the dead map.
      if (rebuild3dTimer) {
        clearTimeout(rebuild3dTimer);
        rebuild3dTimer = null;
      }
      links3dLayer = null;
      links3dPicks = [];
      cursor3dActive = false;
      measureControl = null;
      measureDragIndex = -1;
      locationSearchControl = null;
      rightMouseDownPoint = null;
      this.locationSearchActive = false;
      this.contextMenu = null;
      // Tear down the viewshed engine (releases the GPUDevice) and cancel any pending recompute so a
      // remount (Vite HMR) re-inits a fresh device lazily instead of leaking the old one.
      if (viewshedRaf) {
        cancelAnimationFrame(viewshedRaf);
        viewshedRaf = 0;
      }
      if (viewshedTimer) {
        clearTimeout(viewshedTimer);
        viewshedTimer = null;
      }
      viewshedEngine?.destroy();
      viewshedEngine = null;
      viewshedResultCanvas = null;
      viewshedCoords = null;
      viewshedComputing = false;
      viewshedDirty = false;
      viewshedPassPromise = null;
      viewshedLastZoom = -1;
      this.viewshedProgress = null;
      // Drop any in-flight tile counts so an HMR remount starts the loading bar clean.
      mapTileInflight.clear();
      this.mapTiles = { inFlight: 0, peak: 0 };
      this.map.remove();
      this.map = undefined;
      this.nodeMarkers = {};
      attachedMarkers.clear(); // map.remove() already detached the DOM; just forget our bookkeeping
    },
    initMap() {
      // Guard against re-initialising onto a live map: initMap runs from App's onMounted, which
      // fires again on a remount (Vite HMR). Tear the old map down first so its WebGL context and
      // watchers don't leak.
      this.destroyMap();

      // Pull any shared node(s) out of the URL hash into a pending state the confirm banner shows.
      // Strips the hash as it goes, so this is idempotent across the HMR remount above.
      this.parseShareLink();

      // MapLibre globally caps in-flight tile image requests (default 16) across ALL sources. Slow
      // LINZ terrain tiles can otherwise hog every slot and starve the basemap, leaving the map
      // textureless while heightmaps trickle in. Give both room.
      (maplibregl as any).config.MAX_PARALLEL_IMAGE_REQUESTS = 48;

      const start = this.selectedNode;
      const center: [number, number] = [
        start ? start.transmitter.tx_lon : DEFAULT_LON,
        start ? start.transmitter.tx_lat : DEFAULT_LAT,
      ];
      // The `meshdem://` protocol composites every enabled provider over the Mapterhorn baseline (see
      // demTiles.ts). Registered once, globally, before the map reads a style that may reference it
      // (when a provider is persisted on). getOverlays is a closure read fresh on every tile request,
      // so a provider add/edit/delete/toggle is picked up without re-registering the protocol.
      registerDemProtocol(maplibregl, () => enabledOverlaySpecs(this.allDemProviders));
      // markRaw is essential: this.map lives in Pinia state, so without it Vue deep-proxies the Map
      // and its internal registries, breaking MapLibre's identity-based event bookkeeping — the same
      // hazard that applied to Leaflet (see the leaflet-markraw memory).
      this.map = markRaw(
        new maplibregl.Map({
          container: 'map',
          style: buildStyle(
            this.activeBasemap,
            this.terrainEnabled,
            this.terrainExaggeration,
            this.allDemProviders.some((p) => p.enabled),
          ),
          center,
          zoom: 10,
          // MSAA on the default framebuffer: smooths the terrain silhouette and, crucially, gives the
          // 3D link lines anti-aliased edges (LineMaterial.alphaToCoverage relies on multisampling).
          canvasContextAttributes: { antialias: true },
          // Shift+drag box-zoom is unused here and steals every shift+left-click (even a zero-move
          // click): on mouseup it unconditionally calls the internal DOM.suppressClick(), which kills
          // the click event before it reaches a marker's own listener — breaking shift-click pairing.
          boxZoom: false,
          maxPitch: 85, // unlocks tilt/rotate for reading hill elevation in 3D
          // A top-down view renders identically to flat (see toggleTerrain), so open tilted when 3D
          // is on to make the relief visible.
          pitch: this.terrainEnabled ? 60 : 0,
        })
      );
      // The compass gives tilt/rotate handles; visualizePitch shows the current pitch on the control.
      this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'bottom-left');
      this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
      measureControl = new MeasureControl(() => this.toggleMeasure());
      this.map.addControl(measureControl, 'bottom-left');
      // Added last: MapLibre prepends bottom-corner controls, so this lands above the measure tool.
      this.map.addControl(new HotkeyHelpControl(), 'bottom-left');
      // Added last of all: lands above the hotkey-help button.
      locationSearchControl = new LocationSearchControl(() => this.toggleLocationSearch());
      this.map.addControl(locationSearchControl, 'bottom-left');

      if (!this.selectedNodeId && this.nodes[0]) {
        this.selectedNodeId = this.nodes[0].id;
      }

      const map = this.map as maplibregl.Map; // just assigned above; never undefined here
      // Source/layer setup must run after the style loads — MapLibre rejects addSource/addLayer
      // before then. On a remount the new map fires 'load' again and restores every overlay from the
      // persisted in-memory state.
      map.on('load', () => {
        if (this.map !== map) {
          return; // a newer initMap superseded this map
        }
        this.setupOverlays();
        this.renderNodeMarkers();
        this.redrawSites();
        this.redrawLinks();
        this.redrawRelay();
        if (this.viewshedEnabled) {
          this.computeViewshed(); // restore the LOS overlay after a (re)mount when it was left on
        }
        // The map shares the row with the docked sidebar, so its container is narrower than the
        // viewport. Init usually reads the right size, but resize once here in case the flex layout
        // settled a frame after the canvas was created.
        map.resize();
      });

      // Markers can render immediately; the rest waits for 'load'.
      this.renderNodeMarkers();

      // Keep markers + link endpoints in sync with manual lat/lon edits and renames. Guarded against
      // re-rendering mid-drag (dragend handles that). Live-apply the transparency slider too.
      watchStops.push(
        watch(
          () =>
            this.nodes
              .map((n) => `${n.id}:${n.transmitter.tx_lat}:${n.transmitter.tx_lon}:${n.transmitter.name}`)
              .join('|'),
          () => {
            if (!this.dragging) {
              this.renderNodeMarkers();
              this.redrawLinks();
              if (this.viewshedEnabled) {
                this.requestViewshed(); // manual lat/lon edits (not a drag) move the observer too
              }
            }
          }
        ),
        watch(
          () => this.splatParams.display.overlay_transparency,
          () => this.applyCoverageOpacity()
        ),
        // Recompute the viewshed when its inputs change: radius, target height, or the selected node's
        // antenna height (the observer eye). Coordinate moves are covered by the drag handler and the
        // node watch above. Debounced so slider/keystroke bursts don't stack GPU passes.
        watch(
          () => {
            const n = this.selectedNode;
            return `${this.viewshedRadiusKm}:${this.viewshedTargetHeight}:${n?.id}:${n?.transmitter.tx_height}`;
          },
          () => {
            if (this.viewshedEnabled) {
              this.requestViewshed();
            }
          }
        ),
        // Recompute the SELECTED node's links (the fast per-node path) only when something that changes
        // their viability is actually EDITED — the node's own radio params + coordinates, or a shared
        // param (environment, lora preset). Selecting a DIFFERENT node does NOT recompute: its links are
        // already in the matrix (or the user will compute them), so re-running on every click is wasted
        // work. We tell the two apart via watch's old/new values: the node id is kept before the '|' in
        // the key and the editable signature after it, so we fire only when the id is unchanged but the
        // signature differs. redrawLinks alone can't help (it only re-draws existing margins). Gated on
        // matrixResult (never auto-compute before the user has) and !dragging (fire once on drop, not per
        // frame), debounced so a number-field keystroke burst is one run. (A shared-param edit refreshes
        // only the selected node here; the rest stay until re-computed — the trade for cheap edits at
        // scale.)
        watch(
          () => {
            const n = this.selectedNode;
            const t = n?.transmitter;
            const r = n?.receiver;
            const env = this.splatParams.environment;
            const sig = [
              t?.tx_lat, t?.tx_lon, t?.tx_power, t?.tx_gain, t?.tx_freq, t?.tx_height,
              r?.rx_gain, r?.rx_loss,
              this.splatParams.lora?.preset,
              env.radio_climate, env.polarization, env.clutter_height,
              env.ground_dielectric, env.ground_conductivity, env.atmosphere_bending,
            ].join(':');
            return `${n?.id ?? ''}|${sig}`;
          },
          (newKey, oldKey) => {
            if (!this.matrixResult || this.dragging) {
              return;
            }
            // Different node selected (id before the '|' changed) with no edit — don't recompute.
            if (newKey.slice(0, newKey.indexOf('|')) !== oldKey.slice(0, oldKey.indexOf('|'))) {
              return;
            }
            if (matrixRecomputeTimer) {
              clearTimeout(matrixRecomputeTimer);
            }
            matrixRecomputeTimer = setTimeout(() => {
              matrixRecomputeTimer = null;
              // Re-check the guards: the debounce window may have outlived the matrix being cleared or a
              // drag starting.
              if (this.matrixResult && !this.dragging) {
                this.runNodeLinks();
              }
            }, 300);
          }
        ),
        // Refresh an open profile when either of its endpoints moves — a map drag-drop or a manual
        // lat/lon edit. Tracks only the two endpoint coords (resolved via profileFromId/profileToId),
        // so an unrelated node moving never fires it. runProfile is cache-keyed on the resolved coords:
        // a no-op move returns from cache instantly (no spinner), a real move recomputes the chart and
        // redraws the cyan path. Gated on !dragging so it fires once on drop (not per frame mid-drag),
        // and debounced like the matrix watcher so a lat/lon keystroke burst is one run.
        watch(
          () => {
            const from = this.nodes.find((n) => n.id === this.profileFromId);
            const to = this.nodes.find((n) => n.id === this.profileToId);
            return `${from?.transmitter.tx_lat}:${from?.transmitter.tx_lon}:${to?.transmitter.tx_lat}:${to?.transmitter.tx_lon}`;
          },
          () => {
            if (!this.profileFromId || !this.profileToId || this.dragging) {
              return;
            }
            if (profileRecomputeTimer) {
              clearTimeout(profileRecomputeTimer);
            }
            profileRecomputeTimer = setTimeout(() => {
              profileRecomputeTimer = null;
              // Re-check after the debounce: the profile may have been closed or a drag started.
              if (this.profileFromId && this.profileToId && !this.dragging) {
                this.runProfile(this.profileFromId, this.profileToId);
              }
            }, 300);
          }
        )
      );
    },
    // Add the empty overlay sources and their style layers once, bottom-to-top among overlays:
    //   basemaps < coverage rasters < relay heatmap < links < relay points < DOM markers.
    // Also wire the map-level popups (GeoJSON layers have no per-feature popup).
    setupOverlays() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      map.addSource('links', { type: 'geojson', data: EMPTY_FC as any });
      // 'anchor' carries no features; it backs the two empty z-order anchor layers below (a line layer
      // on an empty source renders nothing).
      map.addSource('anchor', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('relay-pts', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('profile-path', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('pair-link', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('measure-line', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('measure-pts', { type: 'geojson', data: EMPTY_FC as any });

      // Relief shading over the existing raster-dem. Added first so it sits directly above the
      // basemaps and below every data overlay (coverage inserts before 'coverage-top', so it lands
      // on top of this) — the heatmap stays vibrant while only the basemap gets shaded.
      this.addHillshadeLayer(map);

      // Invisible ordering anchors: coverage rasters insert before 'coverage-top', the relay heatmap
      // before 'relay-top'. Added in this order so relay drapes above coverage, both below the
      // link/point vector overlays added next.
      map.addLayer({ id: 'coverage-top', type: 'line', source: 'anchor' } as any);
      map.addLayer({ id: 'relay-top', type: 'line', source: 'anchor' } as any);
      // Dashed (non-viable) vs solid (viable) links: line-dasharray isn't data-drivable, so two
      // layers share the source, split by a filter on the `viable` property.
      map.addLayer({
        id: 'links-solid', type: 'line', source: 'links',
        filter: ['==', ['get', 'viable'], true],
        paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] },
      } as any);
      map.addLayer({
        id: 'links-dashed', type: 'line', source: 'links',
        filter: ['==', ['get', 'viable'], false],
        paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'], 'line-dasharray': [2, 2] },
      } as any);
      // The 3D line-of-sight links (chords through the air + AGL masts), drawn on top of the 2D
      // lines. queryTerrainElevation only reads loaded tiles, so rebuild as the view changes and as
      // terrain tiles stream in (debounced — both events fire rapidly). Only meaningful with terrain.
      links3dLayer = new Links3DLayer();
      // addLayer runs the layer's onAdd, which creates its three.js material/mesh — so the curtain
      // settings must be applied AFTER, not before (otherwise they touch undefined and throw).
      map.addLayer(links3dLayer as any);
      links3dLayer.setCurtainOpacity(this.linkCurtainOpacity);
      links3dLayer.setCurtainVisible(this.linkCurtainEnabled);
      map.on('moveend', () => this.rebuild3dLinks());
      map.on('moveend', () => this.cullMarkers());
      map.on('moveend', () => {
        // The viewshed fetches at the map's zoom (to reuse its warm tiles), so follow a zoom change —
        // zooming in sharpens it against the map's now-finer tiles. Gate on the integer zoom changing
        // so plain panning (same node-centred bbox, same tiles → a cache hit) doesn't re-run.
        if (this.viewshedEnabled && Math.round(map.getZoom()) !== viewshedLastZoom) {
          this.requestViewshed();
        }
      });
      map.on('data', (e: any) => {
        if (e.dataType === 'source' && e.sourceId === 'terrain-dem' && e.tile) {
          this.rebuild3dLinks();
        }
      });

      // Bottom loading bar: count in-flight tiles across ALL sources (basemap + terrain + sim) from
      // the per-source tile events (MapLibre 5): sourcedataloading marks a tile starting, sourcedata
      // /sourcedataabort/error mark one finishing. Only events carrying a tile count — source metadata
      // changes (no e.tile) are ignored. MapLibre's areTilesLoaded() reconciles away any stale key
      // (e.g. a tile aborted by the terrain source-swap), without relying on 'idle', which never fires
      // while the 3D layers trigger continuous repaints.
      //
      // CRITICAL: these handlers fire SYNCHRONOUSLY inside MapLibre operations — including the cascade
      // of aborts removeSource() emits when the swap tears down the slow sim-terrain tiles. So every
      // handler is wrapped: a throw here (e.g. areTilesLoaded() touching a half-removed source) would
      // propagate out of removeSource and abort the swap itself, leaving the terrain stuck.
      const tileKey = (e: any): string | null =>
        e.tile ? `${e.sourceId}:${e.tile.tileID?.canonical?.key ?? e.tile.tileID?.key ?? ''}` : null;
      const refreshTiles = () => {
        try {
          if (map.areTilesLoaded()) {
            mapTileInflight.clear(); // MapLibre says nothing is outstanding → drop any stragglers
          }
        } catch {
          /* transient mid source-swap; the next event reconciles */
        }
        const n = mapTileInflight.size;
        this.mapTiles.inFlight = n;
        this.mapTiles.peak = n === 0 ? 0 : Math.max(this.mapTiles.peak, n);
      };
      const onTileStart = (e: any) => {
        try {
          const k = tileKey(e);
          if (k) {
            mapTileInflight.add(k);
          }
          refreshTiles();
        } catch {
          /* never let the loading-bar tracker break a MapLibre operation */
        }
      };
      const onTileEnd = (e: any) => {
        try {
          const k = tileKey(e);
          if (k) {
            mapTileInflight.delete(k);
          }
          refreshTiles();
        } catch {
          /* never let the loading-bar tracker break a MapLibre operation */
        }
      };
      map.on('sourcedataloading', onTileStart);
      map.on('sourcedata', onTileEnd);
      map.on('sourcedataabort', onTileEnd);
      map.on('error', onTileEnd);
      map.on('idle', onTileEnd);
      // Click + hover picking for the 3D lines: their 2D click target is offset from the visible line
      // once the camera tilts, so hit-test the elevated geometry directly. Only active with terrain on
      // (the 2D layer handlers in wireOverlayPopups bow out then); the general click also fires for the
      // 2D layers but they short-circuit, so there's no double popup.
      map.on('click', (e: any) => {
        if (!this.links3dActive || this.measureActive) {
          return;
        }
        const hit = this.pick3dLink(e.point);
        if (hit) {
          this.showLinkPopupAt(hit.a, hit.b, e.lngLat);
        }
      });
      // Track the pointer's lng/lat so the "A" hotkey can drop a node under the cursor; cleared on
      // mouseout so it can't reuse a stale position once the pointer leaves the map (see addNodeAtCursor).
      map.on('mousemove', (e: any) => { lastMapCursor = e.lngLat; });
      map.on('mouseout', () => { lastMapCursor = null; });
      // 'contextmenu' fires on right-mouseup for both a plain click and a rotate-drag release;
      // only treat near-zero movement since mousedown as a real menu request.
      map.on('mousedown', (e: any) => {
        if (e.originalEvent.button === 2) {
          rightMouseDownPoint = { x: e.point.x, y: e.point.y };
        }
      });
      map.on('contextmenu', (e: any) => {
        e.originalEvent.preventDefault();
        const down = rightMouseDownPoint;
        rightMouseDownPoint = null;
        if (down && Math.hypot(e.point.x - down.x, e.point.y - down.y) > 5) {
          return; // was a rotate-drag release, not a click
        }
        this.openContextMenu(e.point.x, e.point.y, e.lngLat.lat, e.lngLat.lng);
      });
      // Hover cursor, throttled to one pick per frame so mousemove doesn't reproject every link.
      let hoverScheduled = false;
      map.on('mousemove', (e: any) => {
        if (!this.links3dActive || this.measureActive || hoverScheduled) {
          return;
        }
        hoverScheduled = true;
        requestAnimationFrame(() => {
          hoverScheduled = false;
          const hit = this.pick3dLink(e.point);
          if (hit) {
            map.getCanvas().style.cursor = 'pointer';
            cursor3dActive = true;
          } else if (cursor3dActive) {
            map.getCanvas().style.cursor = '';
            cursor3dActive = false;
          }
        });
      });
      this.set3dLinksVisible(this.links3dActive);
      map.addLayer({
        id: 'relay-pts', type: 'circle', source: 'relay-pts',
        paint: {
          'circle-radius': 7,
          'circle-color': ['get', 'fill'],
          'circle-stroke-color': '#1d3557',
          'circle-stroke-width': 2,
          'circle-opacity': 0.95,
        },
      } as any);
      // The point-to-point profile path. A bright dashed line on top of everything so the slice the
      // bottom-strip chart describes is obvious against the basemap, links and coverage.
      map.addLayer({
        id: 'profile-path-line', type: 'line', source: 'profile-path',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#22d3ee', 'line-width': 3, 'line-dasharray': [1.5, 1.5] },
      } as any);
      // The dashed ground link previewing a shift-clicked node pair, before it's computed. Amber to
      // echo the selected pin's highlight and to read as "pending" against the cyan profile path.
      map.addLayer({
        id: 'pair-link-line', type: 'line', source: 'pair-link',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ffb703', 'line-width': 2.5, 'line-dasharray': [2, 2] },
      } as any);
      // Magenta to stand apart from the cyan profile path and amber pair preview.
      map.addLayer({
        id: 'measure-line-line', type: 'line', source: 'measure-line',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f72585', 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
      } as any);
      map.addLayer({
        id: 'measure-pts-circle', type: 'circle', source: 'measure-pts',
        paint: { 'circle-radius': 5, 'circle-color': '#f72585', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
      } as any);
      map.on('click', (e: any) => {
        if (!this.measureActive) {
          return;
        }
        // A click on a vertex is a grab (handled by mousedown), not a new point — skipping it also
        // absorbs a double-click's second click landing on the vertex the first one placed.
        if (map.queryRenderedFeatures(e.point, { layers: ['measure-pts-circle'] }).length) {
          return;
        }
        const pt: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        // After finishing, a click starts a fresh line instead of extending the old one.
        if (measureFinished) {
          measureFinished = false;
          this.measurePoints = [pt];
          this.measureCursor = null;
          this.redrawMeasure();
          return;
        }
        this.measurePoints = [...this.measurePoints, pt];
        this.redrawMeasure();
      });
      map.on('mousemove', (e: any) => {
        if (!this.measureActive) {
          return;
        }
        // A vertex drag takes priority over the rubber-band preview.
        if (measureDragIndex >= 0) {
          const pts = [...this.measurePoints];
          pts[measureDragIndex] = [e.lngLat.lng, e.lngLat.lat];
          this.measurePoints = pts;
          this.redrawMeasure();
          return;
        }
        if (measureFinished || !this.measurePoints.length) {
          return;
        }
        this.measureCursor = [e.lngLat.lng, e.lngLat.lat];
        this.redrawMeasure();
      });
      // preventDefault stops the map panning while dragging; mouseup is on the whole map because the
      // pointer can leave the small dot mid-drag.
      map.on('mousedown', 'measure-pts-circle', (e: any) => {
        if (!this.measureActive) {
          return;
        }
        e.preventDefault();
        measureDragIndex = Number(e.features?.[0]?.properties?.index ?? -1);
        this.measureCursor = null;
        map.getCanvas().style.cursor = 'grabbing';
      });
      map.on('mouseup', () => {
        if (measureDragIndex < 0) {
          return;
        }
        measureDragIndex = -1;
        map.getCanvas().style.cursor = this.measureActive ? 'crosshair' : '';
      });
      // Move cursor signals a draggable vertex; the guard skips mid-drag, where 'grabbing' owns it.
      map.on('mouseenter', 'measure-pts-circle', () => {
        if (this.measureActive && measureDragIndex < 0) {
          map.getCanvas().style.cursor = 'move';
        }
      });
      map.on('mouseleave', 'measure-pts-circle', () => {
        if (this.measureActive && measureDragIndex < 0) {
          map.getCanvas().style.cursor = 'crosshair';
        }
      });
      map.on('dblclick', () => {
        if (!this.measureActive || !this.measurePoints.length) {
          return;
        }
        measureFinished = true;
        this.measureCursor = null;
        this.redrawMeasure();
      });

      this.wireOverlayPopups();
    },
    wireOverlayPopups() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      // The relay zone is a draped raster (no per-feature popups); its candidate points (relay-pts,
      // wired below) carry the interactive info and the Promote button.
      // Link popups carry a "Show line profile" button (relay-pts pattern below): clicking it draws
      // the terrain profile for that pair into the bottom strip.
      for (const layer of ['links-solid', 'links-dashed']) {
        map.on('click', layer, (e: any) => {
          // While the 3D lines are active they are the click target (handled by the general click in
          // setupOverlays); the faint draped 2D line is offset and shouldn't pop up its own. The
          // measure tool also owns the click while it's running.
          if (this.links3dActive || this.measureActive) {
            return;
          }
          const f = e.features?.[0];
          if (!f) {
            return;
          }
          const popup = new maplibregl.Popup({ offset: 8 }).setLngLat(e.lngLat).setHTML(String(f.properties?.popupHtml ?? '')).addTo(map);
          const a = f.properties?.a as string | undefined;
          const b = f.properties?.b as string | undefined;
          const btn = popup.getElement()?.querySelector('.link-profile-btn');
          btn?.addEventListener('click', () => {
            this.runProfile(a ?? null, b ?? null);
            popup.remove();
          }, { once: true });
        });
        // Keep the measure crosshair while the tool is on rather than flipping to the link pointer.
        map.on('mouseenter', layer, () => { if (!this.measureActive) { map.getCanvas().style.cursor = 'pointer'; } });
        map.on('mouseleave', layer, () => { if (!this.measureActive) { map.getCanvas().style.cursor = ''; } });
      }
      // Relay candidate points carry a "Promote to node" button in their popup.
      map.on('click', 'relay-pts', (e: any) => {
        if (this.measureActive) {
          return;
        }
        const f = e.features?.[0];
        if (!f) {
          return;
        }
        const [lon, lat] = f.geometry.coordinates as [number, number]; // geometry coords stay numeric
        const popup = new maplibregl.Popup({ offset: 12 }).setLngLat([lon, lat]).setHTML(String(f.properties?.popupHtml ?? '')).addTo(map);
        const btn = popup.getElement()?.querySelector('.relay-promote-btn');
        btn?.addEventListener('click', () => {
          this.promoteRelayPoint(lat, lon);
          popup.remove();
        }, { once: true });
      });
      map.on('mouseenter', 'relay-pts', () => { if (!this.measureActive) { map.getCanvas().style.cursor = 'pointer'; } });
      map.on('mouseleave', 'relay-pts', () => { if (!this.measureActive) { map.getCanvas().style.cursor = ''; } });
    },
    setBasemap(id: string) {
      this.activeBasemap = id;
      const map = this.map as maplibregl.Map | undefined;
      // setLayoutProperty only needs the layer to exist (the per-layer getLayer below ensures it), not
      // isStyleLoaded — see [[maplibre-isstyleloaded]].
      if (!map) {
        return;
      }
      // Overlays keep a fixed z-order via beforeId, so switching the basemap never disturbs them.
      for (const b of BASEMAPS) {
        if (map.getLayer('basemap-' + b.id)) {
          map.setLayoutProperty('basemap-' + b.id, 'visibility', b.id === id ? 'visible' : 'none');
        }
      }
    },
    // Reveal/hide the NZ aerial (LINZ) basemap button. If turning it off while that basemap is active,
    // fall back to the global Satellite so the map isn't left on a basemap whose button just vanished.
    toggleNzBasemap() {
      this.nzBasemapEnabled = !this.nzBasemapEnabled;
      if (!this.nzBasemapEnabled && this.activeBasemap === 'linz-aerial') {
        this.setBasemap('satellite');
      }
    },
    toggleTerrain() {
      this.terrainEnabled = !this.terrainEnabled;
      if (this.terrainEnabled) {
        trackEvent('terrain-3d-enable');
      }
      this.applyTerrain();
      this.set3dLinksVisible(this.links3dActive);
      this.rebuild3dLinks();
      // Terrain relief only shows when the camera is tilted — a flat top-down view looks identical
      // with terrain on or off (and rotating bearing alone doesn't reveal it). Pitch in on enable so
      // turning it on visibly does something; resetView() returns to top-down.
      if (this.terrainEnabled) {
        const map = this.map as maplibregl.Map | undefined;
        if (map && map.getPitch() < 20) {
          map.easeTo({ pitch: 60 });
        }
      }
    },
    setTerrainExaggeration(x: number) {
      this.terrainExaggeration = x;
      if (this.terrainEnabled) {
        this.applyTerrain();
        this.rebuild3dLinks(); // altitudes scale with exaggeration
      }
    },
    setLinkCurtainOpacity(x: number) {
      this.linkCurtainOpacity = x;
      // Material-only change — repaint without rebuilding geometry.
      if (links3dLayer) {
        links3dLayer.setCurtainOpacity(x);
        const map = this.map as maplibregl.Map | undefined;
        map?.triggerRepaint();
      }
    },
    // Master switch for the whole 3D-links feature. When off, the flat 2D draped links return to full
    // opacity and become the click target again.
    toggleLinks3d() {
      this.links3dEnabled = !this.links3dEnabled;
      this.set3dLinksVisible(this.links3dActive);
      this.rebuild3dLinks();
    },
    // Toggle "only show the selected node's links" (see visibleLinks). redrawLinks re-filters both the
    // 2D and 3D links from the new visible set.
    toggleLinksSelectedOnly() {
      this.linksSelectedOnly = !this.linksSelectedOnly;
      this.redrawLinks();
    },
    // Toggle hiding non-viable links (see visibleLinks). redrawLinks re-filters the 2D + 3D links from
    // the new visible set, so the dashed (non-viable) layer empties on its own when this turns on.
    toggleHideInvalidLinks() {
      this.hideInvalidLinks = !this.hideInvalidLinks;
      this.redrawLinks();
    },
    toggleLinkCurtain() {
      this.linkCurtainEnabled = !this.linkCurtainEnabled;
      if (links3dLayer) {
        links3dLayer.setCurtainVisible(this.linkCurtainEnabled);
        const map = this.map as maplibregl.Map | undefined;
        map?.triggerRepaint();
      }
    },
    toggleHillshade() {
      this.hillshadeEnabled = !this.hillshadeEnabled;
      const map = this.map as maplibregl.Map | undefined;
      if (map && map.getLayer('hillshade')) {
        map.setLayoutProperty('hillshade', 'visibility', this.hillshadeEnabled ? 'visible' : 'none');
      }
    },
    setHillshadeExaggeration(x: number) {
      this.hillshadeExaggeration = x;
      const map = this.map as maplibregl.Map | undefined;
      if (map && map.getLayer('hillshade')) {
        map.setPaintProperty('hillshade', 'hillshade-exaggeration', x);
      }
    },
    // Re-point the terrain-dem source at the current provider state and refresh everything that reads
    // it. Called after any change to a provider (toggle, add, edit, delete).
    applyTerrainOverlays() {
      const map = this.map as maplibregl.Map | undefined;
      const src = map?.getSource('terrain-dem') as { setTiles?: (t: string[]) => void } | undefined;
      if (!map || !src?.setTiles) {
        return;
      }
      // Swap the source's tile URLs in place — Mapterhorn direct when nothing is enabled, the meshdem://
      // compositor otherwise. setTiles reloads the source, so the 3D mesh and the hillshade re-read the
      // new surface without a removeSource/addSource teardown (which would tear down terrain + the
      // hillshade layer).
      src.setTiles(terrainDemSource(this.allDemProviders.some((p) => p.enabled)).tiles);
      // setTerrain re-reads the reloaded DEM; rebuild the 3D links against the new heights. The
      // sim/viewshed heightmap LRU is keyed by the overlay set (heightmap.ts), so it refetches on its
      // next run; re-run the live viewshed now so the change is visible immediately.
      this.applyTerrain();
      this.rebuild3dLinks();
      if (this.viewshedEnabled) {
        this.requestViewshed();
      }
    },
    // Toggle a built-in (LINZ) or user-added provider by id — both kinds share one enabled switch in
    // the UI. Builtin ids are the fixed ones from builtinDemProviders(); anything else is looked up in
    // customDemProviders.
    toggleProviderEnabled(id: string) {
      if (builtinDemProviders().some((p) => p.id === id)) {
        this.builtinProviderEnabled[id] = !(this.builtinProviderEnabled[id] ?? false);
      } else {
        const provider = this.customDemProviders.find((p) => p.id === id);
        if (!provider) {
          return;
        }
        provider.enabled = !provider.enabled;
      }
      this.applyTerrainOverlays();
    },
    addCustomDemProvider(name: string, urlTemplate: string, encoding: 'mapbox' | 'terrarium') {
      trackEvent('terrain-provider-add-custom');
      this.customDemProviders.push({ id: crypto.randomUUID(), name, urlTemplate, encoding, enabled: true });
      this.applyTerrainOverlays();
    },
    updateCustomDemProvider(id: string, patch: Partial<Omit<DemProvider, 'id' | 'builtin'>>) {
      const provider = this.customDemProviders.find((p) => p.id === id);
      if (!provider) {
        return;
      }
      Object.assign(provider, patch);
      this.applyTerrainOverlays();
    },
    removeCustomDemProvider(id: string) {
      const idx = this.customDemProviders.findIndex((p) => p.id === id);
      if (idx === -1) {
        return;
      }
      this.customDemProviders.splice(idx, 1);
      this.applyTerrainOverlays();
    },
    // Fetches one real tile from the given URL at the map's current centre and reports whether it
    // decoded to a plausible elevation — lets the add/edit form catch a bad URL/key/encoding before save.
    async testDemProvider(urlTemplate: string, encoding: 'mapbox' | 'terrarium'): Promise<ProviderTestResult> {
      const c = this.map ? (this.map as maplibregl.Map).getCenter() : { lng: DEFAULT_LON, lat: DEFAULT_LAT };
      return testProviderTile(urlTemplate, encoding, c.lng, c.lat);
    },
    applyTerrain() {
      const map = this.map as maplibregl.Map | undefined;
      // setTerrain only needs the DEM source to exist, so gate on that, not isStyleLoaded — see
      // [[maplibre-isstyleloaded]].
      if (!map || !map.getSource('terrain-dem')) {
        return;
      }
      map.setTerrain(this.terrainEnabled ? { source: 'terrain-dem', exaggeration: this.terrainExaggeration } : null);
    },
    // Add the relief-shading layer over the terrain raster-dem. beforeId keeps it below the data
    // overlays; omit it on first setup, where the relay/coverage layers are added afterwards anyway.
    addHillshadeLayer(map: maplibregl.Map, beforeId?: string) {
      map.addLayer({
        id: 'hillshade',
        type: 'hillshade',
        source: 'terrain-dem',
        layout: { visibility: this.hillshadeEnabled ? 'visible' : 'none' },
        paint: {
          // Multidirectional gives the soft, ambient-occlusion-like look; illumination-anchor 'map'
          // keeps the light fixed to the ground rather than the camera.
          'hillshade-method': 'multidirectional',
          'hillshade-exaggeration': this.hillshadeExaggeration,
          'hillshade-illumination-anchor': 'map',
          // Shadows only: the default white highlight brightens sunlit slopes, which washes out
          // solid-colour basemaps. Transparent highlight leaves just the darkening.
          'hillshade-highlight-color': 'rgba(255, 248, 227, 0.48)',
        },
      } as any, beforeId);
    },
    resetView() {
      this.map?.easeTo({ pitch: 0, bearing: 0 });
    },
    // Fly to a point on the ground viewed side-on at a near-horizontal tilt — used by the profile
    // chart to inspect where a link's beam meets the terrain. viewBearing is perpendicular to the
    // link, so the path runs left-to-right across the screen. Force the 3D view on (if off) so the
    // beam-vs-terrain intersection is actually visible.
    focusTerrainView(lng: number, lat: number, viewBearing: number) {
      if (!this.terrainEnabled) this.toggleTerrain();
      if (!this.links3dEnabled) this.toggleLinks3d();
      const map = this.map as maplibregl.Map | undefined;
      map?.flyTo({
        center: [lng, lat],
        bearing: viewBearing,
        pitch: 75, // near-horizontal side view (maxPitch is 85)
        zoom: Math.max(map.getZoom(), 15),
        duration: 1200,
      });
    },
    // Compute the coverage overlay in the browser (WASM ITM, off-thread). The result drapes through the
    // Site/overlay model as a palette canvas on a MapLibre canvas source, so the visibility toggle,
    // opacity slider and multi-site stacking all apply.
    async runSimulation() {
      const node = this.selectedNode;
      if (!node) {
        console.warn('No node selected; cannot run simulation.');
        return;
      }
      trackEvent('simulation-coverage-run');

      // Supersede any in-flight coverage run so its now-stale grid stops arriving.
      coverageCancel?.();
      coverageCancel = null;

      const display = this.splatParams.display;
      const tx: CoverageNode = {
        lat: node.transmitter.tx_lat,
        lon: node.transmitter.tx_lon,
        height: node.transmitter.tx_height,
        tx_power: 10 * Math.log10(node.transmitter.tx_power) + 30, // watts -> dBm
        tx_gain: node.transmitter.tx_gain,
        frequency_mhz: node.transmitter.tx_freq,
        // Receiver params live per-node (splatParams holds only the shared blocks).
        system_loss: node.receiver.rx_loss,
      };
      // simulation_extent is a radius in km; clamp the half-extent so one run can't request a
      // continent-sized terrain fetch.
      const radiusM = Math.min(100000, this.splatParams.simulation.simulation_extent * 1000);

      // Coverage is a RADIAL SWEEP from the TX (sharp near-site detail), not a uniform per-cell grid.
      // The preset picks the ITM budget (az rays × rangeSteps samples/ray — cost ≈ az × rangeSteps²/2,
      // since each ray reruns ITM over a growing prefix). The OUTPUT raster size is derived from the
      // preset's target cell size over the chosen range and clamped to the user's overlay texture cap
      // (coverageGridSize) — a cheap rasterization target decoupled from the ITM cost, so a finer grid
      // just sharpens the overlay.
      const preset = (this.splatParams.simulation.quality ?? 'balanced') as keyof typeof COVERAGE_PRESETS;
      const { az, rangeSteps } = COVERAGE_PRESETS[preset];
      const textureCap = effectiveTextureCap(this.splatParams.simulation.overlay_max_texture);
      const renderGrid = coverageGridSize(radiusM, preset, textureCap);

      // A stable id per run, used to name the overlay layer/source and drive the visibility toggle.
      const taskId = crypto.randomUUID();

      this.simulationState = 'running';
      this.progress = { message: 'Fetching terrain…', fraction: 0 };

      const { promise, cancel } = runCoverageWorker({
        source: this._simSource(),
        tx,
        shared: this._simShared(),
        radiusM,
        gridSize: renderGrid,
        rxHeightM: node.receiver.rx_height,
        azimuths: az,
        rangeSteps,
        // Terrain fetch fills 0->0.4, the radial sweep fills 0.4->1.0, mirroring runMatrix's split.
        onHeightmapProgress: (loaded, total) => {
          this.progress = { message: `Loading terrain ${loaded}/${total}…`, fraction: total ? 0.4 * (loaded / total) : 0 };
        },
        onProgress: (done, total) => {
          this.progress = { message: `Computing coverage ${done}/${total}…`, fraction: 0.4 + (total ? 0.6 * (done / total) : 0) };
        },
      });
      coverageCancel = cancel;

      try {
        const grid = await promise;
        // Colorize the dBm grid into an RGBA canvas. The grid is latitude-even, so mercatorWarp
        // resamples its rows into web-mercator spacing and fitCoverageCanvas dodges the square-power-
        // of-two black-texture bug. markRaw keeps the canvas out of Vue's deep reactivity.
        const colored = colorizeGrid(grid, display.min_dbm, display.max_dbm, display.color_scale);
        const warped = mercatorWarp(colored, grid.north, grid.south);
        // Cap at the user-chosen overlay texture limit (same cap that sized renderGrid), so a grid
        // taken above the default 4096 isn't downsampled back to it on upload.
        const image = markRaw(fitCoverageCanvas(warped, textureCap));
        // Four corners [lng,lat]: TL, TR, BR, BL (north-up, axis-aligned).
        const coords: Site['coords'] = [
          [grid.west, grid.north], [grid.east, grid.north],
          [grid.east, grid.south], [grid.west, grid.south],
        ];
        const params: SplatParams = cloneObject({
          transmitter: node.transmitter,
          receiver: node.receiver,
          environment: this.splatParams.environment,
          simulation: this.splatParams.simulation,
          display: this.splatParams.display,
        });
        this.localSites.push({ params, taskId, raster: null, visible: true, image, coords });
        this.redrawSites();
        this.simulationState = 'completed';
        this.progress = null;
      } catch (error) {
        // A cancelled run was superseded by a newer one — let that newer run own the state.
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Coverage error:', error);
        this.simulationState = 'failed';
        this.progress = null;
      } finally {
        if (coverageCancel === cancel) {
          coverageCancel = null;
        }
      }
    },
    redrawLinks() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      // Gate on the source existing, not isStyleLoaded() (see [[maplibre-isstyleloaded]]): here a false
      // reading right after a profile computes would skip the 2D update and rebuild3dLinks() below, so
      // the merged link wouldn't show until the next camera move re-triggered the 3D rebuild.
      const src = map.getSource('links') as maplibregl.GeoJSONSource | undefined;
      if (!src) {
        return;
      }
      if (!this.matrixResult) {
        src.setData(EMPTY_FC as any);
        return;
      }
      const byId: Record<string, Node> = {};
      for (const n of this.nodes) {
        byId[n.id] = n;
      }
      const features: any[] = [];
      for (const link of this.visibleLinks) {
        const a = byId[link.a];
        const b = byId[link.b];
        if (!a || !b) {
          continue; // node was deleted since the matrix ran
        }
        features.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [a.transmitter.tx_lon, a.transmitter.tx_lat],
              [b.transmitter.tx_lon, b.transmitter.tx_lat],
            ],
          },
          properties: {
            color: linkColor(link.margin_db),
            width: link.viable ? 3 : 1.5,
            opacity: link.viable ? 0.9 : 0.5,
            viable: link.viable,
            a: link.a,
            b: link.b,
            popupHtml: linkPopupHtml(link, a.transmitter.name, b.transmitter.name),
          },
        });
      }
      src.setData({ type: 'FeatureCollection', features } as any);
      this.rebuild3dLinks();
    },
    // Rebuild the 3D line-of-sight geometry from the current matrix + node positions, sampling the
    // rendered terrain. Debounced because its triggers ('moveend', terrain 'data') fire in bursts,
    // and gated on terrain being on (queryTerrainElevation returns null otherwise — nothing to clip
    // against). The 2D links remain the click target, so this is purely visual.
    rebuild3dLinks() {
      if (rebuild3dTimer) {
        clearTimeout(rebuild3dTimer);
      }
      rebuild3dTimer = setTimeout(() => {
        rebuild3dTimer = null;
        const map = this.map as maplibregl.Map | undefined;
        if (!map || !links3dLayer || !map.getLayer('links-3d')) {
          return;
        }
        if (!this.links3dActive || !this.matrixResult) {
          links3dLayer.clear();
          links3dPicks = [];
          map.triggerRepaint();
          return;
        }
        const byId: Record<string, Node> = {};
        for (const n of this.nodes) {
          byId[n.id] = n;
        }
        const geom = buildLinkGeometry(
          this.visibleLinks,
          byId,
          (ll) => map.queryTerrainElevation(ll) ?? null,
          this.terrainExaggeration,
        );
        links3dLayer.setData(geom);
        links3dPicks = geom.picks;
        map.triggerRepaint();
      }, 200);
    },
    // Mirror the profile chart's hover dot onto the 3D line-of-sight beam. f is the path fraction
    // (0..1) measured from the profiled link's "from" node; null clears the marker. We ride the
    // already-built 3D pick polyline (absolute mercator, sampled along the sagged chord) so the dot
    // sits exactly on the rendered beam — no need to re-query terrain or recompute the curvature.
    setBeamCursor(f: number | null) {
      const layer = links3dLayer;
      if (!layer) {
        return;
      }
      const fromId = this.profileFromId;
      const toId = this.profileToId;
      if (f === null || !this.links3dActive || !fromId || !toId) {
        layer.setBeamCursor(null);
        return;
      }
      const pk = links3dPicks.find(
        (p) => (p.a === fromId && p.b === toId) || (p.a === toId && p.b === fromId),
      );
      const n = pk ? pk.pts.length / 3 : 0;
      if (!pk || n < 2) {
        layer.setBeamCursor(null);
        return;
      }
      // Pick polylines run a→b; flip the fraction when the profile's "from" is the pick's b end.
      const t = pk.a === fromId ? f : 1 - f;
      const pos = Math.min(n - 1, Math.max(0, t * (n - 1)));
      const i0 = Math.floor(pos);
      const i1 = Math.min(n - 1, i0 + 1);
      const fr = pos - i0;
      const pts = pk.pts;
      const lerp = (k: number) => pts[i0 * 3 + k] + (pts[i1 * 3 + k] - pts[i0 * 3 + k]) * fr;
      layer.setBeamCursor([lerp(0), lerp(1), lerp(2)]);
      (this.map as maplibregl.Map | undefined)?.triggerRepaint();
    },
    // Show the 3D links only with terrain on, and dim the draped 2D links to a faint ground
    // reference so they still anchor the links and keep their popups/"Show line profile" clickable.
    set3dLinksVisible(on: boolean) {
      const map = this.map as maplibregl.Map | undefined;
      if (!map || !map.getLayer('links-3d')) {
        return;
      }
      map.setLayoutProperty('links-3d', 'visibility', on ? 'visible' : 'none');
      // Multiply the data-driven per-feature opacity down when 3D is on; restore it when off.
      const dim = on ? 0.25 : 1;
      for (const id of ['links-solid', 'links-dashed']) {
        if (map.getLayer(id)) {
          map.setPaintProperty(id, 'line-opacity', ['*', ['get', 'opacity'], dim]);
        }
      }
      if (!on && cursor3dActive) {
        map.getCanvas().style.cursor = '';
        cursor3dActive = false;
      }
    },
    // Hit-test a screen point against the elevated 3D link polylines (projected with the layer's
    // current matrix). Returns the nearest link's endpoint ids within the pixel threshold, or null.
    pick3dLink(point: { x: number; y: number }): { a: string; b: string } | null {
      const layer = links3dLayer;
      if (!layer) {
        return null;
      }
      const THRESHOLD = 8; // px
      let best: LinkPick | null = null;
      let bestDist = THRESHOLD;
      for (const pk of links3dPicks) {
        const pts = pk.pts;
        let prev: { x: number; y: number } | null = null;
        for (let i = 0; i < pts.length; i += 3) {
          const s = layer.project(pts[i], pts[i + 1], pts[i + 2]);
          if (s && prev) {
            const d = distToSegment(point, prev, s);
            if (d < bestDist) {
              bestDist = d;
              best = pk;
            }
          }
          prev = s; // null breaks the polyline across the camera plane
        }
      }
      return best ? { a: best.a, b: best.b } : null;
    },
    // Open the link popup for an endpoint pair at a clicked location, with the profile button wired —
    // the 3D-line equivalent of the 2D layer's click handler.
    showLinkPopupAt(a: string, b: string, lngLat: maplibregl.LngLat) {
      const map = this.map as maplibregl.Map | undefined;
      if (!map || !this.matrixResult) {
        return;
      }
      const byId: Record<string, Node> = {};
      for (const n of this.nodes) {
        byId[n.id] = n;
      }
      const nodeA = byId[a];
      const nodeB = byId[b];
      const link = this.matrixResult.links.find((l) => l.a === a && l.b === b);
      if (!nodeA || !nodeB || !link) {
        return;
      }
      const popup = new maplibregl.Popup({ offset: 8 })
        .setLngLat(lngLat)
        .setHTML(linkPopupHtml(link, nodeA.transmitter.name, nodeB.transmitter.name))
        .addTo(map);
      const btn = popup.getElement()?.querySelector('.link-profile-btn');
      btn?.addEventListener('click', () => {
        this.runProfile(a, b);
        popup.remove();
      }, { once: true });
    },
    // Shift-click pairing: stage a second node against the selected one. Draws the dashed preview
    // link and opens a popup whose button computes the link + profile. The pair is transient — any
    // change of the primary selection (selectNode) or loss of either node clears it.
    setPairTarget(id: string) {
      if (!this.selectedNodeId || id === this.selectedNodeId) {
        return;
      }
      this.pairTargetId = id;
      this.redrawPairLink();
      this.showPairPopup();
    },
    clearPairTarget() {
      this.pairTargetId = null;
      if (pairPopup) {
        // Null the ref first so the popup's own 'close' handler (below) sees the pairing already
        // gone and doesn't recurse back into clearPairTarget.
        const p = pairPopup;
        pairPopup = null;
        p.remove();
      }
      this.redrawPairLink(); // no target now → clears the source
    },
    // Draw the dashed amber preview between the selected node and the pending pair target (or clear
    // it). Mirrors redrawProfilePath but on the 'pair-link' source.
    redrawPairLink() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      const src = map.getSource('pair-link') as maplibregl.GeoJSONSource | undefined;
      if (!src) {
        return;
      }
      const a = this.nodes.find((n) => n.id === this.selectedNodeId);
      const b = this.nodes.find((n) => n.id === this.pairTargetId);
      if (!a || !b) {
        src.setData(EMPTY_FC as any);
        return;
      }
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [a.transmitter.tx_lon, a.transmitter.tx_lat],
              [b.transmitter.tx_lon, b.transmitter.tx_lat],
            ],
          },
          properties: {},
        }],
      } as any);
    },
    // Popup anchored at the pair target with a button that runs the profile (which also computes the
    // link and merges it onto the map). Reuses the wiring pattern from showLinkPopupAt.
    showPairPopup() {
      const map = this.map as maplibregl.Map | undefined;
      const a = this.nodes.find((n) => n.id === this.selectedNodeId);
      const b = this.nodes.find((n) => n.id === this.pairTargetId);
      if (!map || !a || !b) {
        return;
      }
      if (pairPopup) {
        pairPopup.remove();
        pairPopup = null;
      }
      const popup = new maplibregl.Popup({ offset: 30 })
        .setLngLat([b.transmitter.tx_lon, b.transmitter.tx_lat])
        .setHTML(pairPopupHtml(a.transmitter.name, b.transmitter.name))
        .addTo(map);
      const btn = popup.getElement()?.querySelector('.pair-profile-btn');
      btn?.addEventListener('click', () => {
        const from = this.selectedNodeId;
        const to = this.pairTargetId;
        this.clearPairTarget(); // closes this popup; runProfile draws its own cyan profile path
        this.runProfile(from, to);
      }, { once: true });
      const relayBtn = popup.getElement()?.querySelector('.pair-relay-btn');
      relayBtn?.addEventListener('click', () => {
        const from = this.selectedNodeId;
        const to = this.pairTargetId;
        this.clearPairTarget(); // closes this popup
        this.relayA = from;
        this.relayB = to;
        this.activeMode = 'linkfinder'; // surface the RelayFinder panel showing the run
        this.runRelay(from!, to!);
      }, { once: true });
      // Dismissing the popup (its X or a click away) cancels the pending pair. Guarded by the ref
      // check so clearPairTarget's own remove() doesn't re-enter.
      popup.on('close', () => {
        if (pairPopup === popup) {
          pairPopup = null;
          this.clearPairTarget();
        }
      });
      pairPopup = popup;
    },
    // Resolve the terrain tile source for the client-side sim exactly as the map/viewshed do, so
    // simulations run against the surface currently drawn (Mapterhorn + the active overlays), at the
    // zoom the map is showing — see computeViewshed for the same resolution. The sim composites from the
    // Mapterhorn base template + overlays (not the map's meshdem:// URL, which it can't fetch).
    _simSource(): SimSource {
      const mapZoom = this.map ? (this.map as maplibregl.Map).getZoom() : 10;
      return {
        urlTemplate: MAPTERHORN_TEMPLATE,
        overlays: enabledOverlaySpecs(this.allDemProviders),
        maxzoom: DEM_MAXZOOM,
        mapZoom,
      };
    },
    // Shared environment/model params for a client-side ITM run (matrix, profile, coverage, relay).
    _simShared(): SimShared {
      return {
        clutter_height: this.splatParams.environment.clutter_height,
        ground_dielectric: this.splatParams.environment.ground_dielectric,
        ground_conductivity: this.splatParams.environment.ground_conductivity,
        atmosphere_bending: this.splatParams.environment.atmosphere_bending,
        radio_climate: this.splatParams.environment.radio_climate,
        polarization: this.splatParams.environment.polarization,
        situation_fraction: this.splatParams.simulation.situation_fraction,
        time_fraction: this.splatParams.simulation.time_fraction,
      };
    },
    // Per-path terrain-profile fidelity for the client sims, from the Draft/Balanced/High preset.
    // Draft samples coarsely for speed; High follows the displayed terrain's own pixel resolution
    // (targetSpacingM omitted → one sample per heightmap pixel). Read defensively: the preset may be
    // absent on params persisted before it existed (mergeDefaults is shallow).
    _simQuality(): ProfileOptions {
      switch (this.splatParams.simulation.quality ?? 'balanced') {
        case 'draft':
          return { targetSpacingM: 150, maxPoints: 256 };
        case 'high':
          return { maxPoints: 2048 };
        case 'max':
          return { maxPoints: 4096 };
        default:
          return { maxPoints: 1024 };
      }
    },
    // Per-path fidelity for the ON-DEMAND single-line sims — the line profile and the per-pair corridor
    // matrix. Both can afford far more samples than the bulk coverage sweep, so lift the cap well above
    // the preset's (a long link then follows the DEM's own pixel detail instead of being vertex-limited)
    // while keeping the preset's spacing, so Draft stays Draft. Sharing this between runMatrix and
    // runProfile is what makes a link's matrix margin and its profile margin agree.
    _simPathQuality(): ProfileOptions {
      const q = this._simQuality();
      return { ...q, maxPoints: Math.max(q.maxPoints ?? 0, 4096) };
    },
    // Receiver sensitivity (dBm) from the shared LoRa SF/BW. Falls back to LongFast's values when
    // missing — covers localStorage written before these fields existed (useLocalStorage's merge is
    // shallow, so old `lora: { preset: 'LongFast' }` entries won't get them auto-filled).
    _simSensitivity(): number {
      const sf = this.splatParams.lora?.spreadingFactor ?? MESHTASTIC_PRESETS[DEFAULT_PRESET].spreadingFactor;
      const bw = this.splatParams.lora?.bandwidthKhz ?? MESHTASTIC_PRESETS[DEFAULT_PRESET].bandwidthKhz;
      return receiverSensitivityDbm(sf, bw);
    },
    // The SimNode payload (one per node) the link pipeline consumes (tx_power watts->dBm, the rest passed
    // straight through). Shared by the full matrix and the per-node path.
    _linkSimNodes(): SimNode[] {
      return this.nodes.map((n) => ({
        id: n.id,
        lat: n.transmitter.tx_lat,
        lon: n.transmitter.tx_lon,
        height: n.transmitter.tx_height,
        tx_power: 10 * Math.log10(n.transmitter.tx_power) + 30, // watts -> dBm
        tx_gain: n.transmitter.tx_gain,
        rx_gain: n.receiver.rx_gain,
        frequency_mhz: n.transmitter.tx_freq,
        system_loss: n.receiver.rx_loss,
      }));
    },
    // Core link computation (browser WASM ITM), streamed pair-by-pair. With sourceNodeId set, only that
    // node's links are computed and MERGED into the existing matrix (the fast interactive path); without
    // it, the full N² matrix is computed fresh. Links land one at a time via onLink (upsert + throttled
    // redraw) so they populate the map progressively as their terrain arrives.
    async _runLinks(sourceNodeId?: string) {
      if (this.nodes.length < 2) {
        console.warn('Need at least 2 nodes to compute links.');
        return;
      }
      // Supersede any in-flight run (full or per-node) so its now-stale results stop arriving.
      matrixCancel?.();
      matrixCancel = null;

      this.matrixState = 'running';
      const preset = this.splatParams.lora?.preset ?? 'LongFast';
      const sensitivity = this._simSensitivity();
      const sensitivityRounded = Math.round(sensitivity * 100) / 100;

      if (sourceNodeId === undefined || !this.matrixResult) {
        // Full matrix, or the first per-node run: start from a blank result and fill in as links land.
        this.matrixResult = { nodes: [], preset, sensitivity_dbm: sensitivityRounded, links: [], computedSourceIds: [] };
      } else {
        // Per-node into an existing matrix: keep the other nodes' links; the header reflects this run.
        this.matrixResult.preset = preset;
        this.matrixResult.sensitivity_dbm = sensitivityRounded;
      }
      this.redrawLinks();

      this.progress = { message: 'Fetching terrain…', fraction: 0 };
      // Throttle the redraw so ~hundreds of upserts don't fire ~hundreds of full link redraws; a final
      // redraw flushes the tail on completion.
      let lastDraw = 0;
      const { promise, cancel } = runMatrixWorker({
        source: this._simSource(),
        nodes: this._linkSimNodes(),
        shared: this._simShared(),
        sensitivity,
        // Same per-path quality the dedicated profile uses, so a matrix link stays close to its profile.
        quality: this._simPathQuality(),
        // ?? true: mergeDefaults is shallow, so params stored before this key existed lack it.
        filterHorizon: this.splatParams.simulation.filter_radio_horizon ?? true,
        sourceNodeId,
        // Full-matrix-only distance cap; buildPairs ignores it for per-node runs. 0 = off.
        maxDistanceKm: sourceNodeId === undefined ? (this.splatParams.simulation.max_link_distance_km ?? 0) : 0,
        onLink: (link, done, total) => {
          this.upsertMatrixLink(link);
          this.progress = { message: `Computing links ${done}/${total}…`, fraction: total ? done / total : 0 };
          const now = performance.now();
          if (now - lastDraw >= 150) {
            lastDraw = now;
            this.redrawLinks();
          }
        },
      });
      matrixCancel = cancel;

      try {
        await promise;
        this.redrawLinks(); // flush the final batch of upserts
        // Mark which node(s) this run actually attempted every pair for, so a still-missing link is
        // known to be genuinely out of range rather than just not computed yet (see computedSourceIds).
        if (this.matrixResult) {
          if (sourceNodeId === undefined) {
            this.matrixResult.computedSourceIds = this.nodes.map((n) => n.id);
          } else if (!this.matrixResult.computedSourceIds.includes(sourceNodeId)) {
            this.matrixResult.computedSourceIds.push(sourceNodeId);
          }
        }
        this.matrixState = 'completed';
        this.progress = null;
      } catch (error) {
        // A cancelled run was superseded by a newer one — let that newer run own the state.
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Link computation error:', error);
        this.matrixState = 'failed';
        this.progress = null;
      } finally {
        if (matrixCancel === cancel) {
          matrixCancel = null;
        }
      }
    },
    // Compute the FULL link matrix (every pair), replacing any existing result. The "Compute all" button.
    async runMatrix() {
      trackEvent('simulation-matrix-run');
      await this._runLinks(undefined);
    },
    // Compute only the SELECTED node's links (fast) and merge them into the existing matrix. Drives the
    // primary LinkMatrix button, the L shortcut, and the on-edit auto-recompute.
    async runNodeLinks(nodeId?: string) {
      const id = nodeId ?? this.selectedNode?.id;
      if (!id) {
        console.warn('Select a node to compute its links.');
        return;
      }
      await this._runLinks(id);
    },
    // Abort an in-flight link run (full or per-node) at the user's request. Whatever links already
    // landed stay (they're upserted as they arrive); the run is NOT marked computed, so still-missing
    // pairs read as "not yet calculated" rather than out of range. _runLinks's await rejects with an
    // AbortError it swallows, so state is settled here instead of there.
    cancelMatrix() {
      if (!matrixCancel) {
        return;
      }
      matrixCancel();
      matrixCancel = null;
      this.matrixState = this.matrixResult && this.matrixResult.links.length > 0 ? 'completed' : 'idle';
      this.progress = null;
      this.redrawLinks(); // flush any links that landed before the abort
    },
    // Run a point-to-point terrain/LOS profile between two nodes and show it in the bottom strip.
    // Called from the Check-LOS control and from the on-map link popup; the from node is the TX,
    // the to node the RX (its tx_height is the antenna height, matching the link-matrix convention).
    async runProfile(fromId: string | null, toId: string | null) {
      const a = this.nodes.find((n) => n.id === fromId);
      const b = this.nodes.find((n) => n.id === toId);
      if (!a || !b || a.id === b.id) {
        console.warn('Line profile needs two distinct nodes.');
        return;
      }
      trackEvent('simulation-profile-run');
      this.profileFromId = a.id;
      this.profileToId = b.id;
      this.profileError = null;
      this.redrawProfilePath();

      const sensitivity = this._simSensitivity();
      // tx carries the radio params (power/gain/freq) plus the RX node's loss as system_loss; rx carries
      // only position/height/rx_gain.
      const tx: SimNode = {
        id: a.id,
        lat: a.transmitter.tx_lat,
        lon: a.transmitter.tx_lon,
        height: a.transmitter.tx_height,
        tx_power: 10 * Math.log10(a.transmitter.tx_power) + 30, // watts -> dBm
        tx_gain: a.transmitter.tx_gain,
        rx_gain: a.receiver.rx_gain,
        frequency_mhz: a.transmitter.tx_freq,
        system_loss: b.receiver.rx_loss,
      };
      const rx: SimNode = {
        id: b.id,
        lat: b.transmitter.tx_lat,
        lon: b.transmitter.tx_lon,
        height: b.transmitter.tx_height,
        tx_power: 0,
        tx_gain: 0,
        rx_gain: b.receiver.rx_gain,
        frequency_mhz: b.transmitter.tx_freq,
        system_loss: 0,
      };
      const shared = this._simShared();

      // The resolved inputs fully determine the result, so they double as the cache key: editing a
      // node or any radio param changes the key and forces a recompute; reopening an unchanged pair
      // is instant.
      const cacheKey = JSON.stringify({ tx, rx, shared, sensitivity });
      const cached = this.profileCache[cacheKey];
      if (cached) {
        this.profileResult = cached;
        this.profileState = 'completed';
        this.progress = null;
        this.redrawProfilePath();
        this.mergeProfileLink();
        return;
      }

      // Supersede any in-flight profile.
      profileCancel?.();
      profileCancel = null;
      this.profileState = 'running';
      this.progress = { message: 'Fetching terrain…', fraction: 0 };

      const { promise, cancel } = runProfileWorker({
        source: this._simSource(),
        tx,
        rx,
        shared,
        sensitivity,
        // Shared with the per-pair corridor matrix (_simPathQuality) so this pair's profile margin and
        // its matrix margin are computed from the same terrain at the same density — they agree.
        quality: this._simPathQuality(),
        onHeightmapProgress: (loaded, total) => {
          this.progress = { message: `Loading terrain ${loaded}/${total}…`, fraction: total ? 0.8 * (loaded / total) : 0 };
        },
      });
      profileCancel = cancel;

      try {
        // markRaw: the result holds a terrain array of many points and is cached; keep it out of Vue's
        // deep reactivity (its contents never mutate). Reassigning profileResult still re-renders.
        const result = markRaw(await promise);
        this.profileResult = result;
        this.profileCache[cacheKey] = result;
        this.profileState = 'completed';
        this.progress = null;
        this.redrawProfilePath();
        this.mergeProfileLink();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Profile error:', error);
        this.profileError = error instanceof Error ? error.message : 'Profile computation failed.';
        this.profileState = 'failed';
        this.progress = null;
      } finally {
        if (profileCancel === cancel) {
          profileCancel = null;
        }
      }
    },
    // Insert or replace one link in matrixResult by its unordered pair — matches LinkMatrix's lookup, so
    // recomputing a pair updates it in place and the reverse direction never doubles up — and list both
    // endpoints in matrixResult.nodes. Does NOT redraw: callers own the timing (immediate for a single
    // profile merge, throttled for the streaming runs). matrixResult must already exist.
    upsertMatrixLink(link: LinkResult) {
      if (!this.matrixResult) {
        return;
      }
      const links = this.matrixResult.links;
      const idx = links.findIndex((l) => (l.a === link.a && l.b === link.b) || (l.a === link.b && l.b === link.a));
      if (idx >= 0) {
        links[idx] = link;
      } else {
        links.push(link);
      }
      for (const id of [link.a, link.b]) {
        if (!this.matrixResult.nodes.includes(id)) {
          this.matrixResult.nodes.push(id);
        }
      }
    },
    // Persist the just-computed profile pair as a normal link on the map. A ProfileResult carries every
    // LinkResult field, so convert it and upsert into matrixResult.links, then redraw (which also rebuilds
    // the 3D links). The link then renders + is clickable like any matrix link and survives clearProfile
    // (which only wipes the transient cyan slice), so it stays after the graph is closed.
    mergeProfileLink() {
      const r = this.profileResult;
      const a = this.profileFromId;
      const b = this.profileToId;
      if (!r || !a || !b) {
        return;
      }
      if (!this.matrixResult) {
        this.matrixResult = {
          nodes: [],
          preset: this.splatParams.lora?.preset ?? null,
          sensitivity_dbm: r.sensitivity_dbm,
          links: [],
          computedSourceIds: [],
        };
      }
      this.upsertMatrixLink({
        a,
        b,
        distance_km: r.distance_km,
        path_loss_db: r.path_loss_db,
        rx_power_dbm: r.rx_power_dbm,
        fresnel_pct: r.fresnel_pct,
        margin_db: r.margin_db,
        viable: r.viable,
        error: null,
      });
      this.redrawLinks();
    },
    redrawProfilePath() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      const src = map.getSource('profile-path') as maplibregl.GeoJSONSource | undefined;
      if (!src) {
        return;
      }
      const a = this.nodes.find((n) => n.id === this.profileFromId);
      const b = this.nodes.find((n) => n.id === this.profileToId);
      if (!a || !b) {
        src.setData(EMPTY_FC as any);
        return;
      }
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [a.transmitter.tx_lon, a.transmitter.tx_lat],
              [b.transmitter.tx_lon, b.transmitter.tx_lat],
            ],
          },
          properties: {},
        }],
      } as any);
    },
    clearProfile() {
      this.profileResult = null;
      this.profileError = null;
      this.profileState = 'idle';
      this.profileFromId = null;
      this.profileToId = null;
      this.setBeamCursor(null);
      this.redrawProfilePath();
      this.redrawLinks(); // re-filter: a link forced visible only because its profile was open drops out
    },
    // Find the candidate relay zone between two nodes in the browser (WASM ITM). Runs two coverage
    // passes (one per endpoint) over a SHARED bbox so their grids align, then intersects them per-cell:
    // every location that hears both A and B above sensitivity (plus the hypothetical relay's rx gain)
    // is a candidate site.
    async runRelay(aId: string, bId: string) {
      const a = this.nodes.find((n) => n.id === aId);
      const b = this.nodes.find((n) => n.id === bId);
      if (!a || !b || a.id === b.id) {
        console.warn('Relay finder needs two distinct nodes.');
        return;
      }
      trackEvent('simulation-relay-run');

      // Supersede any in-flight relay run so its now-stale result stops arriving.
      relayCancel?.();
      relayCancel = null;

      // Each endpoint is a coverage TX: power watts->dBm, height from its mast, system_loss from its
      // own receiver, freq from its transmitter — mirroring runSimulation's CoverageNode assembly.
      const toCoverageNode = (n: Node): CoverageNode => ({
        lat: n.transmitter.tx_lat,
        lon: n.transmitter.tx_lon,
        height: n.transmitter.tx_height,
        tx_power: 10 * Math.log10(n.transmitter.tx_power) + 30, // watts -> dBm
        tx_gain: n.transmitter.tx_gain,
        frequency_mhz: n.transmitter.tx_freq,
        system_loss: n.receiver.rx_loss,
      });
      const txA = toCoverageNode(a);
      const txB = toCoverageNode(b);

      // The hypothetical relay's receive antenna height (m AGL). Both endpoint passes use it so they
      // predict the signal at the same relay antenna height.
      const RELAY_RX_HEIGHT_M = 2.0;

      // Per-site search radius (m): the simulation extent in km, capped at 100 km like coverage so one
      // search can't request a continent of terrain.
      const searchRadiusM = Math.min(100000, this.splatParams.simulation.simulation_extent * 1000);

      // Shared bbox covering BOTH endpoints, expanded by the search radius on each side. dLon widens
      // with latitude (a degree of longitude shrinks toward the poles); the cos floor keeps the
      // divisor finite near the poles. Both passes use these exact opts, so the grids align (required
      // by relayOverlap).
      const midLat = (a.transmitter.tx_lat + b.transmitter.tx_lat) / 2;
      const padLat = searchRadiusM / 111320;
      const padLon = searchRadiusM / (111320 * Math.max(0.01, Math.cos(midLat * Math.PI / 180)));
      const west = Math.min(a.transmitter.tx_lon, b.transmitter.tx_lon) - padLon;
      const east = Math.max(a.transmitter.tx_lon, b.transmitter.tx_lon) + padLon;
      const south = Math.min(a.transmitter.tx_lat, b.transmitter.tx_lat) - padLat;
      const north = Math.max(a.transmitter.tx_lat, b.transmitter.tx_lat) + padLat;

      // Size the OUTPUT grid (the rasterization target for the draped heatmap). Each coverage pass is a
      // radial sweep whose ITM cost is fixed by its az/rangeSteps, NOT by this grid — so a finer grid
      // only costs a little rasterization + memory and buys a smoother, more detailed overlay. Aim for
      // ~120 m cells, capped near the coverage 'balanced' raster (768²) so the heatmap matches it.
      const TARGET_CELL_M = 120;
      const MAX_GRID = 768;
      const spanLatM = (north - south) * 111320;
      const spanLonM = (east - west) * 111320 * Math.max(0.01, Math.cos(midLat * Math.PI / 180));
      const spanM = Math.max(spanLatM, spanLonM);
      let gridSize = Math.max(64, Math.ceil(spanM / TARGET_CELL_M));
      if (gridSize > MAX_GRID) {
        // Only the overlay resolution is capped here (ITM cost is fixed by the radial sweep), so this
        // just means slightly coarser pixels, not a coarser computation.
        gridSize = MAX_GRID;
      }

      const opts: CoverageOptions = {
        west, south, east, north,
        width: gridSize, height: gridSize,
        rxHeightM: RELAY_RX_HEIGHT_M,
        quality: this._simQuality(),
      };

      const params: RelayParams = {
        sensitivity_dbm: this._simSensitivity(),
        // Node A's receiver gain stands in for the hypothetical relay's rx gain.
        relay_rx_gain: a.receiver.rx_gain,
        band_edges_db: [0.0, 10.0, 20.0],
        top_n: 5, // return the 5 best candidate sites
        node_a_id: a.id,
        node_b_id: b.id,
      };

      this.relayState = 'running';
      this.progress = { message: 'Fetching terrain…', fraction: 0 };

      const { promise, cancel } = runRelayWorker({
        source: this._simSource(),
        txA,
        txB,
        shared: this._simShared(),
        opts,
        params,
        // Terrain fetch fills 0->0.3, the two-pass compute fills 0.3->1.0.
        onHeightmapProgress: (loaded, total) => {
          this.progress = { message: `Loading terrain ${loaded}/${total}…`, fraction: total ? 0.3 * (loaded / total) : 0 };
        },
        onProgress: (done, total) => {
          this.progress = { message: `Searching for relay sites ${done}/${total}…`, fraction: 0.3 + (total ? 0.7 * (done / total) : 0) };
        },
      });
      relayCancel = cancel;

      try {
        // markRaw: the result holds GeoJSON FeatureCollections + a typed-array margin grid that never
        // mutate; keep them out of Vue's deep reactivity (reassigning relayResult still re-renders).
        const result = markRaw(await promise);
        this.relayResult = result;

        // Drape the margin grid as a smooth heatmap through the same pipeline coverage uses, so the
        // relay zone reads like a coverage overlay (continuous colour + soft FADE_BAND edge). The grid
        // carries margin (dB), not dBm, but colorizeGrid is value-agnostic. Range 0..peak uses the full
        // colour ramp; floor the peak so a low-margin zone isn't washed out by a degenerate span.
        if (!result.empty && result.marginGrid) {
          const grid = result.marginGrid;
          let peak = 0;
          for (let i = 0; i < grid.dbm.length; i++) {
            const v = grid.dbm[i];
            if (!Number.isNaN(v) && v > peak) peak = v;
          }
          const colored = colorizeGrid(grid, 0, Math.max(peak, 10), this.splatParams.display.color_scale);
          const warped = mercatorWarp(colored, grid.north, grid.south);
          this.relayImage = markRaw(fitCoverageCanvas(warped));
          this.relayCoords = [
            [grid.west, grid.north], [grid.east, grid.north],
            [grid.east, grid.south], [grid.west, grid.south],
          ];
        } else {
          this.relayImage = null;
          this.relayCoords = null;
        }

        this.relayState = 'completed';
        this.progress = null;
        this.redrawRelay();
      } catch (error) {
        // A cancelled run was superseded by a newer one — let that newer run own the state.
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Relay error:', error);
        this.relayState = 'failed';
        this.progress = null;
      } finally {
        if (relayCancel === cancel) {
          relayCancel = null;
        }
      }
    },
    redrawRelay() {
      const map = this.map as maplibregl.Map | undefined;
      // The guards below suffice (not isStyleLoaded — see [[maplibre-isstyleloaded]]): adding the
      // source/layer only needs the anchor layer to exist, and setData only needs the points source.
      if (!map) {
        return;
      }
      const ptsSrc = map.getSource('relay-pts') as maplibregl.GeoJSONSource | undefined;
      if (!ptsSrc) {
        return;
      }

      // Relay heatmap: drape the colorized margin canvas the same way redrawSites drapes coverage. A
      // fresh canvas comes from each run, so tear down any previous layer/source and re-add (canvas
      // sources don't expose an in-place image swap). RELAY_BEFORE keeps it above coverage, under links.
      if (map.getLayer('relay-cov')) map.removeLayer('relay-cov');
      if (map.getSource('relay-cov')) map.removeSource('relay-cov');
      if (this.relayImage && this.relayCoords && map.getLayer(RELAY_BEFORE)) {
        const opacity = 1 - (this.splatParams.display.overlay_transparency ?? 0) / 100;
        map.addSource('relay-cov', { type: 'canvas', canvas: this.relayImage, coordinates: this.relayCoords, animate: false } as any);
        map.addLayer(
          { id: 'relay-cov', type: 'raster', source: 'relay-cov', paint: { 'raster-opacity': opacity, 'raster-resampling': 'nearest' } } as any,
          RELAY_BEFORE,
        );
      }

      const result = this.relayResult;
      if (!result || result.empty) {
        ptsSrc.setData(EMPTY_FC as any);
        return;
      }

      const pts = {
        type: 'FeatureCollection',
        features: result.points.features.map((f) => {
          const p = f.properties;
          return {
            type: 'Feature',
            geometry: f.geometry,
            properties: {
              ...p,
              fill: linkColor(p.min_margin), // drives circle-color
              popupHtml:
                `<strong>Relay candidate #${p.rank}</strong><br>` +
                `Min margin: ${p.min_margin} dB<br>` +
                `Margin to A: ${p.margin_a} dB · to B: ${p.margin_b} dB<br>` +
                `<button type="button" class="btn btn-sm btn-success mt-2 relay-promote-btn">Promote to node</button>`,
            },
          };
        }),
      };
      ptsSrc.setData(pts as any);
    },
    clearRelay() {
      const map = this.map as maplibregl.Map | undefined;
      // Tear down the draped heatmap layer/source and empty the points. setData/removeLayer only need
      // the layer/source to exist (guarded), not isStyleLoaded() — see [[maplibre-isstyleloaded]].
      if (map) {
        if (map.getLayer('relay-cov')) map.removeLayer('relay-cov');
        if (map.getSource('relay-cov')) map.removeSource('relay-cov');
        (map.getSource('relay-pts') as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC as any);
      }
      this.relayResult = null;
      this.relayImage = null;
      this.relayCoords = null;
      this.relayState = 'idle';
    },
    promoteRelayPoint(lat: number, lon: number, name?: string) {
      const base = this.selectedNode;
      const node: Node = {
        id: crypto.randomUUID(),
        transmitter: {
          ...(base ? cloneObject(base.transmitter) : defaultTransmitter(this.splatParams.lora?.frequencyMhz)),
          name: name ?? randanimalSync(),
          tx_lat: Number(lat.toFixed(6)),
          tx_lon: Number(lon.toFixed(6))
        },
        receiver: base ? cloneObject(base.receiver) : defaultReceiver()
      };
      this.nodes.push(node);
      this.selectedNodeId = node.id;
      this.renderNodeMarkers();
      this.redrawLinks(); // selection changed → re-filter the selected node's non-viable links
    }
  }
});

export { useStore }
