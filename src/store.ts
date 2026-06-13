import { defineStore } from 'pinia';
import { useLocalStorage } from '@vueuse/core';
import { watch, markRaw } from 'vue';
import { randanimalSync } from 'randanimal';
import maplibregl from 'maplibre-gl';
import parseGeoraster from 'georaster';
import { type Site, type SplatParams, type Node, type MatrixResult, type LinkResult, type RelayResult, type ProfileResult, type UiMode } from './types.ts';
import { cloneObject, escapeHtml } from './utils.ts';
import { makePinElement, stylePinElement } from './layers.ts';
import { Links3DLayer, buildLinkGeometry, setLinkColorFn, type LinkPick } from './links3d.ts';

const DEFAULT_LAT = -41.257053283864224;
const DEFAULT_LON = 174.86568331718445;

// Meshtastic LoRa modem presets (must match app/services/link_budget.py PRESET_TABLE).
export const LORA_PRESETS = [
  'ShortTurbo', 'ShortFast', 'ShortSlow', 'MediumFast',
  'MediumSlow', 'LongFast', 'LongModerate', 'LongSlow'
];

// The four switchable raster basemaps. MapLibre has no Leaflet `{s}` subdomain placeholder, so
// subdomained hosts are listed as a tiles[] array (MapLibre rotates over them) and single-host
// sources use one entry. Each carries its own attribution for the AttributionControl.
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
    id: 'satellite',
    label: 'Satellite',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Tiles © Esri — Source: Esri, USGS, NOAA',
    maxzoom: 19,
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

// Coverage rasters insert directly below the vector overlays (relay zone / links / points), so they
// sit above the basemap but under everything else. See setupOverlays for the full z-order.
const COVERAGE_BEFORE = 'relay-zone-fill';
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Conservative floor for gl.MAX_TEXTURE_SIZE across GPUs; a coverage canvas larger than this on
// either axis is downsampled before upload so it never silently fails to render.
const MAX_TEXTURE = 4096;

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

// The popup shown when a second node is shift-clicked: just the pair and a button to compute the
// link + show its profile (wired to runProfile by showPairPopup). No metrics yet — they don't exist
// until the link is calculated.
function pairPopupHtml(aName: string, bName: string): string {
  return `<strong>${escapeHtml(aName)} ↔ ${escapeHtml(bName)}</strong>`
    + `<br><button type="button" class="pair-profile-btn btn btn-sm btn-primary mt-2 w-100">Calculate link &amp; show profile</button>`;
}

// Zoom band for the 3D terrain source, fetched from the backend (GET /terrain/config) so the
// raster-dem source matches the band the backend actually serves. Defaults mirror the backend's so
// the map works unchanged if the config fetch fails. Per-source: DEM is served finer (z15) than DSM
// (z14) — see app/services/terrain_tiles_xyz.py.
type TerrainConfig = { minzoom: number; maxzoom: { dem: number; dsm: number } };
const DEFAULT_TERRAIN_CONFIG: TerrainConfig = { minzoom: 0, maxzoom: { dem: 15, dsm: 14 } };

// AWS Terrarium tiles — the global baseline used for the 'srtm' option (and, server-side, as the
// fallback the backend redirects to outside NZ). Already carry LINZ 8 m DEM over NZ + 30 m SRTM.
const TERRARIUM_TILES = 'https://elevation-tiles-prod.s3.amazonaws.com/v2/terrarium/{z}/{x}/{y}.png';

// Zoom at which one sim post (~30 m hd / ~90 m sd) is roughly a tile pixel; capping the source here
// makes MapLibre overzoom (stretch) the coarse tiles into big flat quads instead of fetching finer
// ones — the low-poly "what SPLAT sees" look. Purely visual; tune to taste.
const SIM_MAXZOOM: Record<string, number> = { sd: 11, hd: 12 };

// The raster-dem source backing both the 3D terrain mesh and the hillshade, chosen by terrain_source:
//   'srtm' → AWS Terrarium directly (global bare-earth baseline, no backend dependency)
//   'dem'/'dsm' → our backend tile endpoint, which serves LINZ LIDAR over NZ and redirects to
//                 Terrarium elsewhere — so the rendered terrain matches the RF simulation's choice.
// With simulationTerrain on, ALL sources instead point at /terrain/sim, which renders the exact
// coarse SDF grid SPLAT analyses (per high_resolution) as low-poly tiles — so the map shows what the
// RF simulation sees rather than the smooth surface.
function terrainDemSource(
  terrainSource: string,
  config: TerrainConfig,
  simulationTerrain: boolean,
  highResolution: boolean,
): any {
  if (simulationTerrain) {
    const res = highResolution ? 'hd' : 'sd';
    return {
      type: 'raster-dem',
      tiles: [`/terrain/sim/${terrainSource}/${res}/{z}/{x}/{y}.png`],
      tileSize: 256,
      encoding: 'terrarium',
      minzoom: 0,
      maxzoom: SIM_MAXZOOM[res],
      attribution: 'Terrain: simulation grid (SPLAT SDF)',
    };
  }
  const isLinz = terrainSource === 'dem' || terrainSource === 'dsm';
  return {
    type: 'raster-dem',
    tiles: isLinz ? [`/terrain/${terrainSource}/{z}/{x}/{y}.png`] : [TERRARIUM_TILES],
    tileSize: 256,
    // 'terrarium' is mandatory: these tiles decode to garbage under the default mapbox encoding.
    encoding: 'terrarium',
    // minzoom 0, not the backend's LINZ threshold: MapLibre must request terrain at every zoom (the
    // map opens at z10) — the backend redirects below LINZ_TILE_MINZOOM to AWS Terrarium itself, so a
    // higher source minzoom would just leave the zoomed-out view with no terrain at all (flat).
    minzoom: 0,
    // Cap requests at the served band; MapLibre overzooms past this rather than fetching finer tiles.
    maxzoom: isLinz ? ((config.maxzoom as any)[terrainSource] ?? 15) : 15,
    attribution: isLinz ? 'Terrain: LINZ (NZ) / AWS Mapzen / SRTM' : 'Terrain: AWS / Mapzen / SRTM',
  };
}

// Live LINZ tiles are slow to render cold (the backend warps a COG window per tile), so the Terrain
// panel offers a "download this view" prefetch that warms them with a progress bar. Concurrency is
// capped to stay gentle on the backend/link; the tile count is capped so one click can't queue a
// whole-country download (zoom in for a smaller, finer area instead).
const PREFETCH_CONCURRENCY = 6;
const MAX_PREFETCH_TILES = 600;

// Slippy-map tile coords for a lon/lat at zoom z (web-mercator XYZ).
function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function latToTileY(lat: number, z: number): number {
  const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}
// XYZ tiles covering a lon/lat bbox at zoom z, padded by `pad` tiles so a little panning is covered too.
function tilesForBounds(w: number, s: number, e: number, n: number, z: number, pad = 2): { z: number; x: number; y: number }[] {
  const max = 2 ** z - 1;
  const x0 = Math.max(0, lonToTileX(w, z) - pad);
  const x1 = Math.min(max, lonToTileX(e, z) + pad);
  const y0 = Math.max(0, latToTileY(n, z) - pad); // north edge -> smaller y
  const y1 = Math.min(max, latToTileY(s, z) + pad);
  const out: { z: number; x: number; y: number }[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      out.push({ z, x, y });
    }
  }
  return out;
}

// Build the initial MapLibre style: the four raster basemaps (the persisted one visible) plus the
// terrain raster-dem for 3D terrain, draped via the style's `terrain` when enabled so both render on
// the first frame. Overlay sources/layers are added later, on 'load'.
function buildStyle(
  activeBasemap: string,
  terrainEnabled: boolean,
  terrainExaggeration: number,
  terrainSource: string,
  terrainConfig: TerrainConfig,
  simulationTerrain: boolean,
  highResolution: boolean,
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
  sources['terrain-dem'] = terrainDemSource(terrainSource, terrainConfig, simulationTerrain, highResolution);
  const style: any = { version: 8, sources, layers };
  // Top-level `terrain` drapes the map over the DEM; runtime toggles go through setTerrain.
  if (terrainEnabled) {
    style.terrain = { source: 'terrain-dem', exaggeration: terrainExaggeration };
  }
  return style;
}

// Decode a colormap PNG (public/colormaps/<scale>.png) into a 256-entry RGBA LUT. Only used as a
// fallback when a coverage GeoTIFF arrives without its embedded palette (it normally has one).
const lutCache: Record<string, Promise<number[][]>> = {};
function colormapLut(scale: string): Promise<number[][]> {
  if (!lutCache[scale]) {
    lutCache[scale] = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 256;
        c.height = 1;
        const cx = c.getContext('2d')!;
        cx.drawImage(img, 0, 0, 256, 1);
        const d = cx.getImageData(0, 0, 256, 1).data;
        const lut: number[][] = [];
        for (let i = 0; i < 256; i++) {
          lut.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], 255]);
        }
        resolve(lut);
      };
      img.onerror = reject;
      img.src = `/colormaps/${scale}.png`;
    });
  }
  return lutCache[scale];
}

// The coverage GeoTIFF is a single-band palette image (colormap baked server-side, nodata at the
// noDataValue index). Decode it to an RGBA canvas once, mapping each palette index to its colour
// and the nodata index to a transparent pixel. Crisp dBm band edges are preserved (no smoothing).
async function buildCoverageCanvas(raster: any, colorScale: string): Promise<HTMLCanvasElement> {
  const width: number = raster.width;
  const height: number = raster.height;
  const band: number[][] = raster.values[0];
  const nodata = raster.noDataValue;
  let palette: number[][] | null = Array.isArray(raster.palette) ? raster.palette : null;
  if (!palette) {
    palette = await colormapLut(colorScale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  const data = img.data;
  for (let y = 0; y < height; y++) {
    const row = band[y];
    for (let x = 0; x < width; x++) {
      const idx = row[x];
      const o = (y * width + x) * 4;
      const color = (idx === nodata || idx === undefined || idx === null || Number.isNaN(idx)) ? null : palette[idx];
      if (!color) {
        data[o + 3] = 0; // nodata / out-of-palette -> fully transparent
        continue;
      }
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = color[3] ?? 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Reproject into Web-Mercator row spacing before handing it to MapLibre's linear image stretch.
  const warped = mercatorWarp(canvas, raster.ymax, raster.ymin);
  return fitCoverageCanvas(warped);
}

const DEG2RAD = Math.PI / 180;
function mercatorY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG2RAD) / 2));
}
function inverseMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG2RAD;
}

// MapLibre image/canvas sources don't reproject: they stretch the image linearly in Web-Mercator Y
// between the corner coordinates, while our GeoTIFF rows are evenly spaced in latitude. For a tall
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
function fitCoverageCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  let w = canvas.width;
  let h = canvas.height;
  const max = Math.max(w, h);
  if (max > MAX_TEXTURE) {
    const scale = MAX_TEXTURE / max;
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

// Four corner coordinates [lng,lat] for a north-up axis-aligned coverage raster: TL, TR, BR, BL.
function coverageCoords(raster: any): Site['coords'] {
  const { xmin, xmax, ymin, ymax } = raster;
  return [[xmin, ymax], [xmax, ymax], [xmax, ymin], [xmin, ymin]];
}

function defaultTransmitter(): SplatParams['transmitter'] {
  return {
    name: randanimalSync(),
    tx_lat: DEFAULT_LAT,
    tx_lon: DEFAULT_LON,
    tx_power: 0.1,
    tx_freq: 907.0,
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
// Elevated per-link polylines for click hit-testing the 3D lines (the 2D click target is offset
// from the visible 3D line once the camera tilts). Rebuilt alongside the geometry.
let links3dPicks: LinkPick[] = [];
// Whether the 3D-line hover handler currently owns the cursor, so it only clears a cursor it set.
let cursor3dActive = false;
// Keys of tiles currently loading across all sources, for the bottom loading bar. Module-scoped (not
// in reactive state) so updating a hot Set per tile event doesn't churn Vue's proxy; its size is
// mirrored into store.mapTiles.inFlight. Reset on map teardown.
const mapTileInflight = new Set<string>();
// The on-map popup offering to compute a shift-clicked node pair. Module-scoped (like the Map) so
// Vue never proxies the GL popup; only one is ever open at a time.
let pairPopup: maplibregl.Popup | null = null;
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

const useStore = defineStore('store', {
  state() {
    return {
      // Typed `any` in state: MapLibre's Map type is too deep for Pinia's reactive state-type
      // unwrap (it trips TS2589), so methods cast this.map to a typed local instead. It's markRaw'd
      // at assignment, so it is never actually made reactive (see initMap / [[leaflet-markraw]]).
      map: undefined as any,
      nodeMarkers: {} as Record<string, maplibregl.Marker>,
      dragging: false,
      activeBasemap: useLocalStorage('activeBasemap', 'osm'),
      // Which sidebar panel the top-bar mode toggle shows. Persisted so the chosen mode survives reload.
      activeMode: useLocalStorage<UiMode>('activeMode', 'nodes'),
      localSites: [] as Site[], // in-memory only (raster/canvas are not JSON-serializable)
      simulationState: 'idle',
      // Live progress for the active job (coverage/matrix/relay), polled from /status.
      progress: null as { message: string; fraction: number | null } | null,
      matrixState: 'idle',
      matrixResult: null as MatrixResult | null, // in-memory only
      relayState: 'idle',
      relayResult: null as RelayResult | null, // in-memory only
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
      // Re-render the terrain mesh + hillshade at the exact coarse SDF grid the RF simulation uses
      // (low-poly, nearest-neighbour) instead of the smooth LINZ/AWS surface, so the map matches what
      // SPLAT sees. Visualisation-only (not a backend param); resolution follows high_resolution.
      simulationTerrain: useLocalStorage('simulationTerrain', false),
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
      // Zoom band for the terrain source, fetched from GET /terrain/config in initMap. In-memory only
      // (it's a backend deployment fact, not a user setting); defaults match the backend so the map
      // works before/without the fetch.
      terrainConfig: { ...DEFAULT_TERRAIN_CONFIG } as TerrainConfig,
      // Progress of a "download terrain for this view" prefetch (null when idle). In-memory only.
      terrainDownload: null as null | { running: boolean; done: number; total: number; cancelled: boolean; tooLarge: boolean },
      // In-flight map tile tracker for the bottom loading bar (basemap + terrain + sim tiles). inFlight
      // mirrors the size of a non-reactive key set; peak is the high-water mark since it last hit zero,
      // so a fraction (peak-inFlight)/peak fills smoothly per burst. In-memory only.
      mapTiles: { inFlight: 0, peak: 0 } as { inFlight: number; peak: number },
      // Relief shading: a MapLibre hillshade layer over the same raster-dem. Independent of 3D — it
      // reads relief on flat solid-colour basemaps too. hillshade-exaggeration is a 0..1 intensity.
      hillshadeEnabled: useLocalStorage('hillshadeEnabled', false),
      hillshadeExaggeration: useLocalStorage('hillshadeExaggeration', 0.3),
      nodes: useLocalStorage<Node[]>('nodes', [seedNode()]),
      selectedNodeId: useLocalStorage<string | null>('selectedNodeId', null),
      // When set, node markers are non-draggable so they can't be moved by accident. Persisted so
      // the lock survives a reload. Manual lat/lon edits in the panel still apply either way.
      nodesLocked: useLocalStorage('nodesLocked', false),
      // shared / global params (per-node radio lives on the nodes themselves)
      splatParams: useLocalStorage('splatParams', {
        lora: {
          preset: 'LongFast'
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
          high_resolution: false,
          terrain_source: 'srtm',
          filter_radio_horizon: true
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
    selectedNode(state): Node | undefined {
      return state.nodes.find((n) => n.id === state.selectedNodeId) ?? state.nodes[0];
    },
    // The 3D links only make sense (and queryTerrainElevation only works) with terrain on, and they
    // can be switched off independently. Gates rendering, click-picking and the 2D-line dimming.
    links3dActive(state): boolean {
      return state.terrainEnabled && state.links3dEnabled;
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
      if (state.linksSelectedOnly) {
        return all.filter(touchesSelected);
      }
      return all.filter((l) => l.viable || touchesSelected(l));
    },
  },
  actions: {
    addNode() {
      const base = this.selectedNode;
      const center = this.map ? this.map.getCenter() : { lat: DEFAULT_LAT, lng: DEFAULT_LON };
      const node: Node = {
        id: crypto.randomUUID(),
        transmitter: {
          ...(base ? cloneObject(base.transmitter) : defaultTransmitter()),
          name: randanimalSync(),
          tx_lat: Number(center.lat.toFixed(6)),
          tx_lon: Number(center.lng.toFixed(6))
        },
        receiver: base ? cloneObject(base.receiver) : defaultReceiver()
      };
      this.nodes.push(node);
      this.selectedNodeId = node.id;
      this.renderNodeMarkers();
      this.redrawLinks(); // selection changed → re-filter the selected node's non-viable links
    },
    selectNode(id: string) {
      this.clearPairTarget(); // a pending pair is relative to the old selection; drop it
      this.selectedNodeId = id;
      this.renderNodeMarkers();
      this.redrawLinks(); // selection drives which non-viable links are visible (see visibleLinks)
    },
    toggleNodesLock() {
      this.nodesLocked = !this.nodesLocked;
      this.renderNodeMarkers(); // re-render flips setDraggable on every existing marker
    },
    deleteNode(id: string) {
      const idx = this.nodes.findIndex((n) => n.id === id);
      if (idx === -1) {
        return;
      }
      this.nodes.splice(idx, 1);
      if (this.pairTargetId === id) {
        this.clearPairTarget(); // the pending pair's target just vanished
      }
      if (this.selectedNodeId === id) {
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
      // Remove markers for nodes that no longer exist.
      for (const id of Object.keys(this.nodeMarkers)) {
        if (!this.nodes.find((n) => n.id === id)) {
          this.nodeMarkers[id].remove();
          delete this.nodeMarkers[id];
        }
      }
      const selectedId = this.selectedNode?.id;
      for (const node of this.nodes) {
        const lngLat: [number, number] = [node.transmitter.tx_lon, node.transmitter.tx_lat];
        const selected = node.id === selectedId;
        let marker = this.nodeMarkers[node.id];
        if (!marker) {
          const el = makePinElement(selected, node.transmitter.name);
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
              // setText (not HTML) closes the latent XSS from Leaflet's bindPopup(name).
              .setPopup(new maplibregl.Popup({ offset: 30 }).setText(node.transmitter.name))
              .addTo(map)
          );
          marker.on('dragstart', () => {
            this.dragging = true;
          });
          marker.on('dragend', () => {
            const { lng, lat } = marker.getLngLat();
            this.updateNodeCoords(node.id, lat, lng);
            this.dragging = false;
            this.redrawPairLink(); // keep the preview attached if this node is in the pending pair
          });
          this.nodeMarkers[node.id] = marker;
        } else {
          marker.setLngLat(lngLat);
          marker.setDraggable(!this.nodesLocked); // re-render is the only path that toggles the lock
          stylePinElement(marker.getElement(), selected, node.transmitter.name); // re-style in place; don't churn markers
          marker.getPopup()?.setText(node.transmitter.name);
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
      // Per-layer getLayer() guards each setPaintProperty below, so only a null map needs gating here.
      // NOT isStyleLoaded(): it reads false while the slow sim-terrain tiles stream, which would drop
      // slider updates. See [[maplibre-isstyleloaded]].
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
      // Drop any in-flight tile counts so an HMR remount starts the loading bar clean.
      mapTileInflight.clear();
      this.mapTiles = { inFlight: 0, peak: 0 };
      this.map.remove();
      this.map = undefined;
      this.nodeMarkers = {};
    },
    async initMap() {
      // Pull the terrain zoom band before building the style so the raster-dem source matches the
      // band the backend serves. Best-effort with a short timeout: if it fails we keep the defaults
      // and the map still works (tiles fall back to Terrarium via the backend redirect).
      await this.fetchTerrainConfig();

      // Guard against re-initialising onto a live map: initMap runs from App's onMounted, which
      // fires again on a remount (Vite HMR). Tear the old map down first so its WebGL context and
      // watchers don't leak.
      this.destroyMap();

      // MapLibre globally caps in-flight tile image requests (default 16) across ALL sources. Slow
      // LINZ terrain tiles can otherwise hog every slot and starve the basemap, leaving the map
      // textureless while heightmaps trickle in. Give both room.
      (maplibregl as any).config.MAX_PARALLEL_IMAGE_REQUESTS = 48;

      const start = this.selectedNode;
      const center: [number, number] = [
        start ? start.transmitter.tx_lon : DEFAULT_LON,
        start ? start.transmitter.tx_lat : DEFAULT_LAT,
      ];
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
            this.splatParams.simulation.terrain_source,
            this.terrainConfig,
            this.simulationTerrain,
            this.splatParams.simulation.high_resolution,
          ),
          center,
          zoom: 10,
          // MSAA on the default framebuffer: smooths the terrain silhouette and, crucially, gives the
          // 3D link lines anti-aliased edges (LineMaterial.alphaToCoverage relies on multisampling).
          canvasContextAttributes: { antialias: true },
          maxPitch: 85, // unlocks tilt/rotate for reading hill elevation in 3D
          // A top-down view renders identically to flat (see toggleTerrain), so open tilted when 3D
          // is on to make the relief visible.
          pitch: this.terrainEnabled ? 60 : 0,
        })
      );
      // The compass gives tilt/rotate handles; visualizePitch shows the current pitch on the control.
      this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'bottom-left');

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
            }
          }
        ),
        watch(
          () => this.splatParams.display.overlay_transparency,
          () => this.applyCoverageOpacity()
        ),
        // Re-point the terrain raster-dem at the new DEM/DSM tile endpoint when the simulation's
        // terrain model changes, so the 3D mesh + hillshade reflect the same surface the sim uses.
        watch(
          () => this.splatParams.simulation.terrain_source,
          () => this.swapTerrainSource()
        ),
        // The "simulation terrain" toggle swaps to/from the low-poly SDF-grid tiles.
        watch(
          () => this.simulationTerrain,
          () => this.swapTerrainSource()
        ),
        // High-Resolution changes the sim grid (30 m vs 90 m); only matters while sim terrain is on
        // (the normal LINZ/Terrarium sources ignore it), so gate the swap on it to avoid churn.
        watch(
          () => this.splatParams.simulation.high_resolution,
          () => {
            if (this.simulationTerrain) {
              this.swapTerrainSource();
            }
          }
        )
      );
    },
    // Add the empty overlay sources and their style layers once, bottom-to-top among overlays:
    //   basemaps < coverage rasters < relay zone (fill, line) < links < relay points < DOM markers.
    // Also wire the map-level popups (GeoJSON layers have no per-feature popup).
    setupOverlays() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      map.addSource('links', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('relay-zone', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('relay-pts', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('profile-path', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('pair-link', { type: 'geojson', data: EMPTY_FC as any });

      // Relief shading over the existing raster-dem. Added first so it sits directly above the
      // basemaps and below every data overlay (coverage inserts before relay-zone-fill, so it lands
      // on top of this) — the heatmap stays vibrant while only the basemap gets shaded.
      this.addHillshadeLayer(map);

      const bandColor = ['match', ['get', 'band'], 0, '#e08326', 1, '#d9c021', '#2e9e3f'];
      map.addLayer({
        id: 'relay-zone-fill', type: 'fill', source: 'relay-zone',
        paint: { 'fill-color': bandColor, 'fill-opacity': 0.35 },
      } as any);
      map.addLayer({
        id: 'relay-zone-line', type: 'line', source: 'relay-zone',
        paint: { 'line-color': bandColor, 'line-width': 1 },
      } as any);
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
        if (!this.links3dActive) {
          return;
        }
        const hit = this.pick3dLink(e.point);
        if (hit) {
          this.showLinkPopupAt(hit.a, hit.b, e.lngLat);
        }
      });
      // Hover cursor, throttled to one pick per frame so mousemove doesn't reproject every link.
      let hoverScheduled = false;
      map.on('mousemove', (e: any) => {
        if (!this.links3dActive || hoverScheduled) {
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

      this.wireOverlayPopups();
    },
    wireOverlayPopups() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      // Read-only info popup for the relay zone.
      for (const layer of ['relay-zone-fill']) {
        map.on('click', layer, (e: any) => {
          const f = e.features?.[0];
          if (!f) {
            return;
          }
          new maplibregl.Popup({ offset: 8 }).setLngLat(e.lngLat).setHTML(String(f.properties?.popupHtml ?? '')).addTo(map);
        });
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }
      // Link popups carry a "Show line profile" button (relay-pts pattern below): clicking it draws
      // the terrain profile for that pair into the bottom strip.
      for (const layer of ['links-solid', 'links-dashed']) {
        map.on('click', layer, (e: any) => {
          // While the 3D lines are active they are the click target (handled by the general click in
          // setupOverlays); the faint draped 2D line is offset and shouldn't pop up its own.
          if (this.links3dActive) {
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
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }
      // Relay candidate points carry a "Promote to node" button in their popup.
      map.on('click', 'relay-pts', (e: any) => {
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
      map.on('mouseenter', 'relay-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'relay-pts', () => { map.getCanvas().style.cursor = ''; });
    },
    setBasemap(id: string) {
      this.activeBasemap = id;
      const map = this.map as maplibregl.Map | undefined;
      // Not gated on isStyleLoaded(): it reads false while source tiles are still streaming (e.g.
      // just after 'load'), and setLayoutProperty only needs the layer to exist — which the
      // per-layer getLayer check below ensures.
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
    toggleTerrain() {
      this.terrainEnabled = !this.terrainEnabled;
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
    applyTerrain() {
      const map = this.map as maplibregl.Map | undefined;
      // Not gated on isStyleLoaded() (false while tiles stream, as in setBasemap); setTerrain only
      // needs the DEM source to exist, so gate on that instead.
      if (!map || !map.getSource('terrain-dem')) {
        return;
      }
      map.setTerrain(this.terrainEnabled ? { source: 'terrain-dem', exaggeration: this.terrainExaggeration } : null);
    },
    // Add the relief-shading layer over the terrain raster-dem. Shared by setupOverlays (initial) and
    // swapTerrainSource (after a source swap). beforeId keeps it below the data overlays on re-add;
    // omit it on first setup, where the relay/coverage layers are added afterwards anyway.
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
    // Re-point the terrain raster-dem at the tile endpoint for the current terrain_source ('dem'/'dsm'
    // /'srtm'), the simulationTerrain toggle, and high_resolution. MapLibre can't mutate a source's
    // url/maxzoom in place, so swap the source: detach terrain, drop the hillshade layer (it references
    // the source), remove + re-add the source with the new url and maxzoom, then restore hillshade and
    // re-attach terrain. Hillshade + 3D mesh both ride the single 'terrain-dem' source, so both follow.
    swapTerrainSource() {
      const map = this.map as maplibregl.Map | undefined;
      // Gate on an overlay layer existing, which means setupOverlays (on 'load') has run: removeSource
      // /addSource need a loaded style, and we re-add the hillshade it created. Before load the source
      // was just built by buildStyle with the current terrain_source, so there's nothing to swap yet.
      if (!map || !map.getLayer('relay-zone-fill')) {
        return;
      }
      const source = this.splatParams.simulation.terrain_source;
      const spec = terrainDemSource(
        source, this.terrainConfig, this.simulationTerrain, this.splatParams.simulation.high_resolution,
      );
      // Detach everything that references the source before removing it (MapLibre errors on removing a
      // live terrain source). Wrapped defensively: tearing down the slow sim-terrain tiles can fail
      // transiently, and that must never leave the map without a terrain source.
      try {
        map.setTerrain(null);
        if (map.getLayer('hillshade')) {
          map.removeLayer('hillshade');
        }
        if (map.getSource('terrain-dem')) {
          map.removeSource('terrain-dem');
        }
      } catch (e) {
        console.error('Terrain swap: detach failed; updating tiles in place', e);
      }
      // Re-add the source, or — if it couldn't be removed — update its tile URLs in place so the
      // terrain still swaps (only maxzoom stays, a cosmetic block-size difference). Either way the
      // terrain-dem source ends up pointing at the right tiles.
      const existing = map.getSource('terrain-dem') as any;
      if (existing) {
        existing.setTiles(spec.tiles);
      } else {
        map.addSource('terrain-dem', spec);
      }
      // Re-add hillshade just below the data overlays (relay-zone-fill is the lowest) so it can't cover them.
      if (!map.getLayer('hillshade')) {
        this.addHillshadeLayer(map, 'relay-zone-fill');
      }
      this.applyTerrain();
      this.rebuild3dLinks(); // terrain heights changed with the source
    },
    // Fetch the backend terrain zoom band (GET /terrain/config) into this.terrainConfig. Best-effort:
    // a short abort timeout and a silent catch so a down/slow backend just leaves the defaults.
    async fetchTerrainConfig() {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch('/terrain/config', { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) {
          return;
        }
        const cfg = await res.json();
        if (cfg && cfg.maxzoom) {
          this.terrainConfig = {
            minzoom: cfg.minzoom ?? DEFAULT_TERRAIN_CONFIG.minzoom,
            maxzoom: {
              dem: cfg.maxzoom.dem ?? DEFAULT_TERRAIN_CONFIG.maxzoom.dem,
              dsm: cfg.maxzoom.dsm ?? DEFAULT_TERRAIN_CONFIG.maxzoom.dsm,
            },
          };
        }
      } catch {
        // backend unreachable/slow: keep defaults; terrain still works via the backend's Terrarium fallback
      }
    },
    // Warm the backend (and browser) cache for the LINZ tiles covering the current view, with a
    // progress bar, so the 3D terrain fills in promptly instead of trickling in over a slow live
    // fetch. Only meaningful for the LINZ sources ('srtm' uses fast AWS tiles directly).
    async downloadVisibleTerrain() {
      const map = this.map as maplibregl.Map | undefined;
      const source = this.splatParams.simulation.terrain_source;
      if (!map || (source !== 'dem' && source !== 'dsm') || this.terrainDownload?.running) {
        return;
      }
      // Fetch at the zoom MapLibre actually requests for this view (capped to the served band), so the
      // warmed tiles are exactly the ones the mesh needs.
      const z = Math.min(Math.round(map.getZoom()), (this.terrainConfig.maxzoom as any)[source] ?? 15);
      const b = map.getBounds();
      const tiles = tilesForBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth(), z);
      if (tiles.length > MAX_PREFETCH_TILES) {
        this.terrainDownload = { running: false, done: 0, total: tiles.length, cancelled: false, tooLarge: true };
        return;
      }
      this.terrainDownload = { running: true, done: 0, total: tiles.length, cancelled: false, tooLarge: false };
      const queue = tiles.slice();
      const worker = async () => {
        while (queue.length) {
          if (this.terrainDownload?.cancelled) {
            return;
          }
          const t = queue.pop()!;
          try {
            // Consume the body so the connection frees and the browser caches the (immutable) tile.
            await (await fetch(`/terrain/${source}/${t.z}/${t.x}/${t.y}.png`)).blob();
          } catch {
            // a failed tile just stays cold; keep going
          }
          if (this.terrainDownload) {
            this.terrainDownload.done++;
          }
        }
      };
      await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
      const cancelled = this.terrainDownload?.cancelled ?? false;
      if (this.terrainDownload) {
        this.terrainDownload.running = false;
      }
      // Re-request the now-cached tiles so the mesh renders immediately (MapLibre won't refetch tiles
      // it already gave up on without a nudge).
      if (!cancelled) {
        this.swapTerrainSource();
      }
    },
    cancelTerrainDownload() {
      if (this.terrainDownload) {
        this.terrainDownload.cancelled = true;
        this.terrainDownload.running = false;
      }
    },
    resetView() {
      this.map?.easeTo({ pitch: 0, bearing: 0 });
    },
    async runSimulation() {
      console.log('Simulation running...')
      try {
        const node = this.selectedNode;
        if (!node) {
          console.warn('No node selected; cannot run simulation.');
          return;
        }
        // Collect input values
        const payload = {
          // Transmitter parameters (per-node)
          lat: node.transmitter.tx_lat,
          lon: node.transmitter.tx_lon,
          tx_height: node.transmitter.tx_height,
          tx_power: 10 * Math.log10(node.transmitter.tx_power) + 30,
          tx_gain: node.transmitter.tx_gain,
          frequency_mhz: node.transmitter.tx_freq,

          // Receiver parameters (per-node)
          rx_height: node.receiver.rx_height,
          rx_gain: node.receiver.rx_gain,
          signal_threshold: node.receiver.rx_sensitivity,
          system_loss: node.receiver.rx_loss,

          // Environment parameters (shared)
          clutter_height: this.splatParams.environment.clutter_height,
          ground_dielectric: this.splatParams.environment.ground_dielectric,
          ground_conductivity: this.splatParams.environment.ground_conductivity,
          atmosphere_bending: this.splatParams.environment.atmosphere_bending,
          radio_climate: this.splatParams.environment.radio_climate,
          polarization: this.splatParams.environment.polarization,

          // Simulation parameters (shared)
          radius: this.splatParams.simulation.simulation_extent * 1000,
          situation_fraction: this.splatParams.simulation.situation_fraction,
          time_fraction: this.splatParams.simulation.time_fraction,
          high_resolution: this.splatParams.simulation.high_resolution,
          terrain_source: this.splatParams.simulation.terrain_source,

          // Display parameters (shared)
          colormap: this.splatParams.display.color_scale,
          min_dbm: this.splatParams.display.min_dbm,
          max_dbm: this.splatParams.display.max_dbm,
        };

        console.log("Payload:", payload);
        this.simulationState = 'running';
        this.progress = null;

        // Send the request to the backend's /predict endpoint
        const predictResponse = await fetch("/predict", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!predictResponse.ok) {
          this.simulationState = 'failed';
          const errorDetails = await predictResponse.text();
          throw new Error(`Failed to start prediction: ${errorDetails}`);
        }

        const predictData = await predictResponse.json();
        const taskId = predictData.task_id;

        console.log(`Prediction started with task ID: ${taskId}`);

        // Poll for task status and result
        const pollInterval = 1000; // 1 seconds
        const pollStatus = async () => {
          const statusResponse = await fetch(
            `/status/${taskId}`,
          );
          if (!statusResponse.ok) {
            throw new Error("Failed to fetch task status.");
          }

          const statusData = await statusResponse.json();
          console.log("Task status:", statusData);
          this.progress = statusData.progress ?? null;

          if (statusData.status === "completed") {
            this.simulationState = 'completed';
            this.progress = null;
            console.log("Simulation completed! Adding result to the map...");

            // Fetch the GeoTIFF data
            const resultResponse = await fetch(
              `/result/${taskId}`,
            );
            if (!resultResponse.ok) {
              throw new Error("Failed to fetch simulation result.");
            }
            else
            {
              const arrayBuffer = await resultResponse.arrayBuffer();
              // markRaw: the parsed georaster is a large in-memory object; keep it raw so it isn't
              // deeply proxied in state.
              const geoRaster = markRaw(await parseGeoraster(arrayBuffer));
              // Decode the palette image to an RGBA canvas once, at parse time (not per redraw).
              const image = markRaw(await buildCoverageCanvas(geoRaster, this.splatParams.display.color_scale));
              const coords = coverageCoords(geoRaster);
              const params: SplatParams = cloneObject({
                transmitter: node.transmitter,
                receiver: node.receiver,
                environment: this.splatParams.environment,
                simulation: this.splatParams.simulation,
                display: this.splatParams.display
              });
              this.localSites.push({
                params,
                taskId,
                raster: geoRaster,
                visible: true,
                image,
                coords
              });
              this.redrawSites();
            }
          }
          else if (statusData.status === "failed") {
            this.simulationState = 'failed';
            this.progress = null;
          } else {
            setTimeout(pollStatus, pollInterval); // Retry after interval
          }
        };

        pollStatus(); // Start polling
      } catch (error) {
        console.error("Error:", error);
      }
    },
    redrawLinks() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      // Gate on the source existing, NOT isStyleLoaded(): the latter is false while terrain/coverage
      // tiles stream — e.g. right after a profile computes — which would skip the 2D update and the
      // rebuild3dLinks() call below, so the merged link wouldn't appear until the next camera move
      // re-triggered the 3D rebuild. See [[maplibre-isstyleloaded]].
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
    async runMatrix() {
      if (this.nodes.length < 2) {
        console.warn('Need at least 2 nodes to compute a link matrix.');
        return;
      }
      try {
        this.matrixState = 'running';
        // Clear the previous matrix so a new run starts from a blank map and fills in as links land,
        // rather than briefly showing stale links until the first partial result arrives.
        this.matrixResult = null;
        this.redrawLinks();
        const preset = this.splatParams.lora?.preset ?? 'LongFast';
        const payload = {
          nodes: this.nodes.map((n) => ({
            id: n.id,
            name: n.transmitter.name,
            lat: n.transmitter.tx_lat,
            lon: n.transmitter.tx_lon,
            height: n.transmitter.tx_height,
            tx_power: 10 * Math.log10(n.transmitter.tx_power) + 30, // watts -> dBm
            tx_gain: n.transmitter.tx_gain,
            rx_gain: n.receiver.rx_gain,
            frequency_mhz: n.transmitter.tx_freq,
            system_loss: n.receiver.rx_loss
          })),
          lora_preset: preset,
          // shared environment / simulation params
          clutter_height: this.splatParams.environment.clutter_height,
          ground_dielectric: this.splatParams.environment.ground_dielectric,
          ground_conductivity: this.splatParams.environment.ground_conductivity,
          atmosphere_bending: this.splatParams.environment.atmosphere_bending,
          radio_climate: this.splatParams.environment.radio_climate,
          polarization: this.splatParams.environment.polarization,
          situation_fraction: this.splatParams.simulation.situation_fraction,
          time_fraction: this.splatParams.simulation.time_fraction,
          high_resolution: this.splatParams.simulation.high_resolution,
          terrain_source: this.splatParams.simulation.terrain_source,
          // ?? true: mergeDefaults is shallow, so params stored before this key existed lack it.
          filter_radio_horizon: this.splatParams.simulation.filter_radio_horizon ?? true
        };

        const matrixResponse = await fetch('/matrix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!matrixResponse.ok) {
          this.matrixState = 'failed';
          throw new Error(`Failed to start matrix: ${await matrixResponse.text()}`);
        }
        const { task_id: taskId } = await matrixResponse.json();
        console.log(`Link matrix started with task ID: ${taskId}`);

        const pollInterval = 1000;
        const pollStatus = async () => {
          const statusResponse = await fetch(`/status/${taskId}`);
          if (!statusResponse.ok) {
            throw new Error('Failed to fetch matrix status.');
          }
          const statusData = await statusResponse.json();
          // Pull whatever links have been computed so far and draw them now — the backend
          // republishes the growing matrix after every pair, so this fills in progressively
          // instead of only rendering once the whole job is done.
          const resultResponse = await fetch(`/matrix/result/${taskId}`);
          if (resultResponse.ok) {
            const data = await resultResponse.json();
            if (data && Array.isArray(data.links)) {
              this.matrixResult = data;
              this.redrawLinks();
            }
          }
          if (statusData.status === 'completed') {
            this.matrixState = 'completed';
          } else if (statusData.status === 'failed') {
            this.matrixState = 'failed';
          } else {
            setTimeout(pollStatus, pollInterval);
          }
        };
        pollStatus();
      } catch (error) {
        console.error('Matrix error:', error);
        this.matrixState = 'failed';
      }
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
      this.profileFromId = a.id;
      this.profileToId = b.id;
      this.profileError = null;
      this.redrawProfilePath();

      const preset = this.splatParams.lora?.preset ?? 'LongFast';
      const payload = {
        tx_lat: a.transmitter.tx_lat,
        tx_lon: a.transmitter.tx_lon,
        tx_height: a.transmitter.tx_height,
        tx_power: 10 * Math.log10(a.transmitter.tx_power) + 30, // watts -> dBm
        tx_gain: a.transmitter.tx_gain,
        rx_lat: b.transmitter.tx_lat,
        rx_lon: b.transmitter.tx_lon,
        rx_height: b.transmitter.tx_height,
        rx_gain: b.receiver.rx_gain,
        frequency_mhz: a.transmitter.tx_freq,
        system_loss: b.receiver.rx_loss,
        lora_preset: preset,
        // shared environment / simulation params (mirror runMatrix)
        clutter_height: this.splatParams.environment.clutter_height,
        ground_dielectric: this.splatParams.environment.ground_dielectric,
        ground_conductivity: this.splatParams.environment.ground_conductivity,
        atmosphere_bending: this.splatParams.environment.atmosphere_bending,
        radio_climate: this.splatParams.environment.radio_climate,
        polarization: this.splatParams.environment.polarization,
        situation_fraction: this.splatParams.simulation.situation_fraction,
        time_fraction: this.splatParams.simulation.time_fraction,
        high_resolution: this.splatParams.simulation.high_resolution,
        terrain_source: this.splatParams.simulation.terrain_source
      };

      // The payload fully determines the result, so it doubles as the cache key: editing a node or
      // any radio param changes the key and forces a recompute; reopening an unchanged pair is instant.
      const cacheKey = JSON.stringify(payload);
      const cached = this.profileCache[cacheKey];
      if (cached) {
        this.profileResult = cached;
        this.profileState = 'completed';
        this.progress = null;
        this.redrawProfilePath();
        this.mergeProfileLink();
        return;
      }

      try {
        this.profileState = 'running';
        this.progress = null;

        const profileResponse = await fetch('/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!profileResponse.ok) {
          this.profileState = 'failed';
          this.profileError = await profileResponse.text();
          throw new Error(`Failed to start profile: ${this.profileError}`);
        }
        const { task_id: taskId } = await profileResponse.json();
        console.log(`Link profile started with task ID: ${taskId}`);

        const pollInterval = 1000;
        const pollStatus = async () => {
          const statusResponse = await fetch(`/status/${taskId}`);
          if (!statusResponse.ok) {
            throw new Error('Failed to fetch profile status.');
          }
          const statusData = await statusResponse.json();
          this.progress = statusData.progress ?? null;
          if (statusData.status === 'completed') {
            const resultResponse = await fetch(`/profile/result/${taskId}`);
            if (!resultResponse.ok) {
              throw new Error('Failed to fetch profile result.');
            }
            // markRaw: the result holds a terrain array of many points and is cached; keep it out of
            // Vue's deep reactivity (its contents never mutate). Reassigning profileResult still
            // triggers the chart to re-render.
            const result = markRaw(await resultResponse.json() as ProfileResult);
            this.profileResult = result;
            this.profileCache[cacheKey] = result;
            this.profileState = 'completed';
            this.progress = null;
            this.redrawProfilePath();
            this.mergeProfileLink();
          } else if (statusData.status === 'failed') {
            // Pull the error text from the result endpoint so the strip can show why (e.g. >100 km).
            const resultResponse = await fetch(`/profile/result/${taskId}`);
            const data = resultResponse.ok ? await resultResponse.json() : null;
            this.profileError = data?.error ?? 'Profile computation failed.';
            this.profileState = 'failed';
            this.progress = null;
          } else {
            setTimeout(pollStatus, pollInterval);
          }
        };
        pollStatus();
      } catch (error) {
        console.error('Profile error:', error);
        this.profileState = 'failed';
      }
    },
    // Persist the just-computed profile pair as a normal link on the map. /profile and /matrix share
    // the same point_to_point() computation, so a ProfileResult carries every LinkResult field —
    // convert it and upsert into matrixResult.links, then reuse redrawLinks (which also rebuilds the
    // 3D links). The link then renders + is clickable like any matrix link and survives clearProfile
    // (which only wipes the transient cyan slice), so it stays after the profile graph is closed.
    mergeProfileLink() {
      const r = this.profileResult;
      const a = this.profileFromId;
      const b = this.profileToId;
      if (!r || !a || !b) {
        return;
      }
      const link: LinkResult = {
        a,
        b,
        distance_km: r.distance_km,
        path_loss_db: r.path_loss_db,
        rx_power_dbm: r.rx_power_dbm,
        fresnel_pct: r.fresnel_pct,
        margin_db: r.margin_db,
        viable: r.viable,
        error: null,
      };
      if (!this.matrixResult) {
        this.matrixResult = {
          nodes: [],
          preset: this.splatParams.lora?.preset ?? null,
          sensitivity_dbm: r.sensitivity_dbm,
          links: [],
        };
      }
      // Upsert on the unordered pair (matches LinkMatrix's lookup) so re-profiling updates in place
      // and we don't draw a duplicate line if the matrix already holds the reverse direction.
      const links = this.matrixResult.links;
      const idx = links.findIndex((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
      if (idx >= 0) {
        links[idx] = link;
      } else {
        links.push(link);
      }
      for (const id of [a, b]) {
        if (!this.matrixResult.nodes.includes(id)) {
          this.matrixResult.nodes.push(id);
        }
      }
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
      this.redrawProfilePath();
    },
    async runRelay(aId: string, bId: string) {
      const a = this.nodes.find((n) => n.id === aId);
      const b = this.nodes.find((n) => n.id === bId);
      if (!a || !b || a.id === b.id) {
        console.warn('Relay finder needs two distinct nodes.');
        return;
      }
      try {
        this.relayState = 'running';
        const preset = this.splatParams.lora?.preset ?? 'LongFast';
        const toNode = (n: Node) => ({
          id: n.id,
          name: n.transmitter.name,
          lat: n.transmitter.tx_lat,
          lon: n.transmitter.tx_lon,
          height: n.transmitter.tx_height,
          tx_power: 10 * Math.log10(n.transmitter.tx_power) + 30, // watts -> dBm
          tx_gain: n.transmitter.tx_gain,
          rx_gain: n.receiver.rx_gain,
          frequency_mhz: n.transmitter.tx_freq,
          system_loss: n.receiver.rx_loss
        });
        const payload = {
          node_a: toNode(a),
          node_b: toNode(b),
          lora_preset: preset,
          relay_rx_gain: a.receiver.rx_gain,
          search_radius_m: this.splatParams.simulation.simulation_extent * 1000,
          top_n: 5,
          // shared environment / simulation params
          clutter_height: this.splatParams.environment.clutter_height,
          ground_dielectric: this.splatParams.environment.ground_dielectric,
          ground_conductivity: this.splatParams.environment.ground_conductivity,
          atmosphere_bending: this.splatParams.environment.atmosphere_bending,
          radio_climate: this.splatParams.environment.radio_climate,
          polarization: this.splatParams.environment.polarization,
          situation_fraction: this.splatParams.simulation.situation_fraction,
          time_fraction: this.splatParams.simulation.time_fraction,
          high_resolution: this.splatParams.simulation.high_resolution,
          terrain_source: this.splatParams.simulation.terrain_source
        };

        const relayResponse = await fetch('/relay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!relayResponse.ok) {
          this.relayState = 'failed';
          throw new Error(`Failed to start relay: ${await relayResponse.text()}`);
        }
        const { task_id: taskId } = await relayResponse.json();
        console.log(`Relay finder started with task ID: ${taskId}`);

        const pollInterval = 1000;
        const pollStatus = async () => {
          const statusResponse = await fetch(`/status/${taskId}`);
          if (!statusResponse.ok) {
            throw new Error('Failed to fetch relay status.');
          }
          const statusData = await statusResponse.json();
          if (statusData.status === 'completed') {
            const resultResponse = await fetch(`/relay/result/${taskId}`);
            if (!resultResponse.ok) {
              throw new Error('Failed to fetch relay result.');
            }
            this.relayResult = await resultResponse.json();
            this.relayState = 'completed';
            this.redrawRelay();
          } else if (statusData.status === 'failed') {
            this.relayState = 'failed';
          } else {
            setTimeout(pollStatus, pollInterval);
          }
        };
        pollStatus();
      } catch (error) {
        console.error('Relay error:', error);
        this.relayState = 'failed';
      }
    },
    redrawRelay() {
      const map = this.map as maplibregl.Map | undefined;
      // NOT isStyleLoaded() (reads false while the slow sim-terrain tiles stream, which would drop the
      // relay result); the source guards below suffice — setData only needs the GeoJSON source to
      // exist. See [[maplibre-isstyleloaded]].
      if (!map) {
        return;
      }
      const zoneSrc = map.getSource('relay-zone') as maplibregl.GeoJSONSource | undefined;
      const ptsSrc = map.getSource('relay-pts') as maplibregl.GeoJSONSource | undefined;
      if (!zoneSrc || !ptsSrc) {
        return;
      }
      const result = this.relayResult;
      if (!result || result.empty) {
        zoneSrc.setData(EMPTY_FC as any);
        ptsSrc.setData(EMPTY_FC as any);
        return;
      }

      // Zone + points come from the backend as FeatureCollections; the zone fill/line colour by
      // `band` via a paint expression, so here we only attach the per-feature popup HTML.
      const zone = {
        type: 'FeatureCollection',
        features: result.zone.features.map((f) => ({
          type: 'Feature',
          geometry: f.geometry,
          properties: {
            ...f.properties,
            popupHtml:
              `<strong>Relay zone</strong><br>` +
              `Band: ${escapeHtml(f.properties.label)}<br>` +
              `Peak margin: ${f.properties.peak_margin} dB<br>` +
              `Area: ${f.properties.area_km2} km²`,
          },
        })),
      };
      zoneSrc.setData(zone as any);

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
      // setData only needs the source to exist (optional-chained), not isStyleLoaded() — which reads
      // false while sim-terrain tiles stream. See [[maplibre-isstyleloaded]].
      if (map) {
        (map.getSource('relay-zone') as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC as any);
        (map.getSource('relay-pts') as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC as any);
      }
      this.relayResult = null;
      this.relayState = 'idle';
    },
    promoteRelayPoint(lat: number, lon: number, name?: string) {
      const base = this.selectedNode;
      const node: Node = {
        id: crypto.randomUUID(),
        transmitter: {
          ...(base ? cloneObject(base.transmitter) : defaultTransmitter()),
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
