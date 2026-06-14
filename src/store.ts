import { defineStore } from 'pinia';
import { useLocalStorage } from '@vueuse/core';
import { watch, markRaw } from 'vue';
import { randanimalSync } from 'randanimal';
import maplibregl from 'maplibre-gl';
import { type Site, type SplatParams, type Node, type MatrixResult, type LinkResult, type RelayResult, type ProfileResult, type UiMode } from './types.ts';
import { cloneObject, escapeHtml } from './utils.ts';
import { makePinElement, stylePinElement } from './layers.ts';
import { Links3DLayer, buildLinkGeometry, setLinkColorFn, type LinkPick } from './links3d.ts';
import { getHeightmap, type Heightmap } from './viewshed/heightmap.ts';
import { ViewshedEngine } from './viewshed/gpu.ts';
import { runMatrix as runMatrixWorker, runProfile as runProfileWorker, runCoverage as runCoverageWorker, runRelay as runRelayWorker, type SimSource } from './sim/simClient.ts';
import type { ProfileOptions } from './sim/profile.ts';
import type { SimNode, SimShared } from './sim/links.ts';
import type { CoverageNode, CoverageOptions } from './sim/coverageTypes.ts';
import type { RelayParams } from './sim/relay.ts';
import { colorizeGrid } from './sim/colormap.ts';
import { receiverSensitivityDbm } from './sim/linkBudget.ts';

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

// AWS Terrarium tiles — the global bare-earth baseline backing both the 3D terrain mesh and the
// hillshade. Already carry LINZ 8 m DEM over NZ + 30 m SRTM elsewhere, with no backend dependency.
const TERRARIUM_TILES = 'https://elevation-tiles-prod.s3.amazonaws.com/v2/terrarium/{z}/{x}/{y}.png';

// Zoom at which Terrarium stops serving finer tiles; MapLibre overzooms past this rather than
// fetching tiles that don't exist. Shared by the map source and the client-side sim/viewshed fetch.
const TERRARIUM_MAXZOOM = 15;

// The single raster-dem source backing the 3D terrain mesh, the hillshade, and the client-side sim
// (matrix/profile/coverage/relay/viewshed). Always AWS Terrarium — global, fast, no backend.
function terrainDemSource(): any {
  return {
    type: 'raster-dem',
    tiles: [TERRARIUM_TILES],
    tileSize: 256,
    // 'terrarium' is mandatory: these tiles decode to garbage under the default mapbox encoding.
    encoding: 'terrarium',
    // minzoom 0 so MapLibre requests terrain at every zoom (the map opens at z10); overzooms past
    // maxzoom rather than fetching finer tiles that don't exist.
    minzoom: 0,
    maxzoom: TERRARIUM_MAXZOOM,
    attribution: 'Terrain: AWS / Mapzen / SRTM',
  };
}

// Build the initial MapLibre style: the four raster basemaps (the persisted one visible) plus the
// terrain raster-dem for 3D terrain, draped via the style's `terrain` when enabled so both render on
// the first frame. Overlay sources/layers are added later, on 'load'.
function buildStyle(
  activeBasemap: string,
  terrainEnabled: boolean,
  terrainExaggeration: number,
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
  sources['terrain-dem'] = terrainDemSource();
  const style: any = { version: 8, sources, layers };
  // Top-level `terrain` drapes the map over the DEM; runtime toggles go through setTerrain.
  if (terrainEnabled) {
    style.terrain = { source: 'terrain-dem', exaggeration: terrainExaggeration };
  }
  return style;
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
// Debounce handle for re-running the link matrix when a link-affecting setting changes (radio params,
// shared environment, lora preset, node coords). Coalesces keystroke/slider bursts into one ITM run.
let matrixRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
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
// The WebGPU viewshed engine + its scheduling/result handles. Module-scoped (not Pinia state) for
// the same reason as the Map and the 3D layer: the GPUDevice and the result canvas must never be
// deep-proxied by Vue. The engine survives mode switches; destroyMap disposes it. viewshedComputing
// /viewshedDirty coalesce overlapping recomputes (a drag can outrun a single async compute).
let viewshedEngine: ViewshedEngine | null = null;
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
      // (which visibleLinks otherwise keeps). Default off to preserve the existing behaviour. Persisted.
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
          filter_radio_horizon: true,
          quality: 'balanced'
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
      // Hidden nodes drop off the map entirely — including every link that touches one — so a user can
      // focus on a subset without deleting the rest. Layered on top of the selected/viable filters
      // below, so it applies in every mode. The matrix itself still spans all nodes, so toggling
      // visibility re-filters instantly without recomputing.
      const hidden = new Set(state.nodes.filter((n) => n.hidden).map((n) => n.id));
      const shown = (l: LinkResult): boolean => !hidden.has(l.a) && !hidden.has(l.b);
      // "Hide invalid links" drops every non-viable link, overriding the selected-node exception that
      // would otherwise still show them (both for selected-only and the default view).
      if (state.hideInvalidLinks) {
        if (state.linksSelectedOnly) {
          return all.filter((l) => l.viable && touchesSelected(l) && shown(l));
        }
        return all.filter((l) => l.viable && shown(l));
      }
      if (state.linksSelectedOnly) {
        return all.filter((l) => touchesSelected(l) && shown(l));
      }
      return all.filter((l) => (l.viable || touchesSelected(l)) && shown(l));
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
      if (this.viewshedEnabled) {
        this.requestViewshed(); // the viewshed is for the selected node — recompute for the new one
      }
    },
    toggleNodesLock() {
      this.nodesLocked = !this.nodesLocked;
      this.renderNodeMarkers(); // re-render flips setDraggable on every existing marker
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
    // Bulk hide/show, behind the node list's "Hide all" / "Show all" buttons. No-op (no redraw) when
    // nothing actually changes, so a redundant click doesn't churn the markers/links.
    setAllNodesHidden(hidden: boolean) {
      let changed = false;
      for (const node of this.nodes) {
        if (Boolean(node.hidden) !== hidden) {
          node.hidden = hidden;
          changed = true;
        }
      }
      if (!changed) {
        return;
      }
      this.renderNodeMarkers();
      this.redrawLinks();
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
      // Remove markers for nodes that no longer exist or have been hidden.
      for (const id of Object.keys(this.nodeMarkers)) {
        const node = this.nodes.find((n) => n.id === id);
        if (!node || node.hidden) {
          this.nodeMarkers[id].remove();
          delete this.nodeMarkers[id];
        }
      }
      const selectedId = this.selectedNode?.id;
      for (const node of this.nodes) {
        if (node.hidden) {
          continue; // hidden nodes have no marker — they're excluded from the map and all links
        }
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
      // The relay heatmap shares the same draped-raster treatment, so the slider drives it too.
      if (map.getLayer('relay-cov')) {
        map.setPaintProperty('relay-cov', 'raster-opacity', opacity);
      }
    },
    // ---- Viewshed (browser-computed WebGPU line-of-sight) ----------------------------------------
    toggleViewshed() {
      this.viewshedEnabled = !this.viewshedEnabled;
      if (this.viewshedEnabled) {
        if (!ViewshedEngine.isSupported()) {
          this.viewshedState = 'unsupported'; // panel shows the WebGPU notice; nothing else to do
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
    // Drape the latest computed footprint as a canvas source + raster layer. Mirrors redrawSites: the
    // result canvas is already web-mercator tile-aligned (no mercatorWarp needed, unlike the lat-spaced
    // SPLAT GeoTIFF), but still needs fitCoverageCanvas to dodge the square-power-of-two black-texture
    // bug. Gate on the overlay slot existing (NOT isStyleLoaded — it reads false while tiles stream).
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
          if (!ViewshedEngine.isSupported()) {
            this.viewshedState = 'unsupported';
            return;
          }
          viewshedEngine = new ViewshedEngine();
          if (!(await viewshedEngine.init())) {
            viewshedEngine = null;
            this.viewshedState = 'unsupported';
            return;
          }
        }
        // Resolve the terrain source exactly as the map does, so the heightmap matches the AWS
        // Terrarium surface currently draped in the viewport.
        const spec = terrainDemSource();
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
            urlTemplate: spec.tiles[0],
            maxzoom: spec.maxzoom ?? 15,
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
    },
    initMap() {
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
        // Re-run the link matrix when anything that changes link viability is edited: the selected
        // node's radio params + coordinates, the shared environment, and the lora preset. redrawLinks
        // only re-draws stale margins from the existing matrixResult, so without this an edit (or even
        // a move) would leave the displayed margins out of date. Mirrors the viewshed watcher: track a
        // stringified tuple, debounce so a number-field keystroke burst is one run, and gate on
        // matrixResult so it never auto-computes before the user has run a matrix, and on !dragging so
        // it fires once on drop rather than per frame mid-drag.
        watch(
          () => {
            const n = this.selectedNode;
            const t = n?.transmitter;
            const r = n?.receiver;
            const env = this.splatParams.environment;
            return [
              n?.id, t?.tx_lat, t?.tx_lon, t?.tx_power, t?.tx_gain, t?.tx_freq, t?.tx_height,
              r?.rx_gain, r?.rx_loss,
              this.splatParams.lora?.preset,
              env.radio_climate, env.polarization, env.clutter_height,
              env.ground_dielectric, env.ground_conductivity, env.atmosphere_bending,
            ].join(':');
          },
          () => {
            if (!this.matrixResult || this.dragging) {
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
                this.runMatrix();
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
      // on an empty source renders nothing). The relay zone is now a draped raster, not GeoJSON.
      map.addSource('anchor', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('relay-pts', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('profile-path', { type: 'geojson', data: EMPTY_FC as any });
      map.addSource('pair-link', { type: 'geojson', data: EMPTY_FC as any });

      // Relief shading over the existing raster-dem. Added first so it sits directly above the
      // basemaps and below every data overlay (coverage inserts before 'coverage-top', so it lands
      // on top of this) — the heatmap stays vibrant while only the basemap gets shaded.
      this.addHillshadeLayer(map);

      // Invisible ordering anchors: coverage rasters insert before 'coverage-top', the relay heatmap
      // before 'relay-top'. Added in this order so relay drapes above coverage (matching the old
      // relay-zone-over-coverage z-order), both below the link/point vector overlays added next.
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
      // The relay zone is a draped raster (no per-feature popups); its candidate points (relay-pts,
      // wired below) carry the interactive info and the Promote button.
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
    applyTerrain() {
      const map = this.map as maplibregl.Map | undefined;
      // Not gated on isStyleLoaded() (false while tiles stream, as in setBasemap); setTerrain only
      // needs the DEM source to exist, so gate on that instead.
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
    // Compute the coverage overlay entirely in the browser (WASM ITM, off-thread), replacing the old
    // /predict round-trip. The result still flows through the existing Site/overlay model — a palette
    // canvas draped as a MapLibre canvas source — so the visibility toggle, opacity slider and
    // multi-site stacking all keep working unchanged; only the source of the canvas has moved client-side.
    async runSimulation() {
      const node = this.selectedNode;
      if (!node) {
        console.warn('No node selected; cannot run simulation.');
        return;
      }

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
        // Receiver params live per-node (splatParams holds only the shared blocks); matches the old
        // /predict payload, which read system_loss/rx_height off the selected node's receiver.
        system_loss: node.receiver.rx_loss,
      };
      // simulation_extent is a radius in km; clamp the half-extent so one run can't request a
      // continent-sized terrain fetch.
      const radiusM = Math.min(100000, this.splatParams.simulation.simulation_extent * 1000);

      // Coverage is a RADIAL SWEEP from the TX (sharp near-site detail), not a uniform per-cell grid.
      // The preset picks the ITM budget (az rays × rangeSteps samples/ray — cost ≈ az × rangeSteps²/2,
      // since each ray reruns ITM over a growing prefix) and the OUTPUT raster size (renderGrid), which
      // is now just a cheap rasterization target decoupled from the ITM cost. Presets are tuned to a
      // sane budget per quality tier independent of the chosen range.
      const COVERAGE = {
        draft: { az: 360, rangeSteps: 160, renderGrid: 512 },
        balanced: { az: 540, rangeSteps: 224, renderGrid: 768 },
        high: { az: 720, rangeSteps: 320, renderGrid: 1024 },
        max: { az: 1080, rangeSteps: 448, renderGrid: 1536 },
      } as const;
      const preset = this.splatParams.simulation.quality ?? 'balanced';
      const { az, rangeSteps, renderGrid } = COVERAGE[preset];

      // A stable id per run so the overlay layer/source naming and the visibility toggle keep working
      // (the server used to supply a task_id; now we mint one locally).
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
        // Colorize the dBm grid into an RGBA canvas, then run it through the SAME draping the GeoTIFF
        // path used: the grid is latitude-even (like the old raster), so mercatorWarp resamples its
        // rows into web-mercator spacing and fitCoverageCanvas dodges the square-power-of-two black
        // texture bug. markRaw keeps the canvas out of Vue's deep reactivity.
        const colored = colorizeGrid(grid, display.min_dbm, display.max_dbm, display.color_scale);
        const warped = mercatorWarp(colored, grid.north, grid.south);
        const image = markRaw(fitCoverageCanvas(warped));
        // Four corners [lng,lat] TL,TR,BR,BL — same north-up axis-aligned layout coverageCoords produced.
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
    // Resolve the terrain tile source for the client-side sim exactly as the map/viewshed do, so
    // simulations run against the AWS Terrarium surface currently drawn, at the zoom the map is
    // showing — see computeViewshed for the same resolution.
    _simSource(): SimSource {
      const spec = terrainDemSource();
      const mapZoom = this.map ? (this.map as maplibregl.Map).getZoom() : 10;
      return { urlTemplate: spec.tiles[0], maxzoom: spec.maxzoom ?? TERRARIUM_MAXZOOM, mapZoom };
    },
    // Shared environment/model params for a client-side ITM run (matrix, profile, and later coverage).
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
    // Receiver sensitivity (dBm) from the shared LoRa preset; falls back to LongFast on a bad value.
    _simSensitivity(): number {
      const preset = this.splatParams.lora?.preset ?? 'LongFast';
      try {
        return receiverSensitivityDbm(preset);
      } catch {
        return receiverSensitivityDbm('LongFast');
      }
    },
    // Compute the full link matrix entirely in the browser (WASM ITM), replacing the old /matrix
    // round-trip. The worker streams results pair-by-pair, mirroring the old progressive render.
    async runMatrix() {
      if (this.nodes.length < 2) {
        console.warn('Need at least 2 nodes to compute a link matrix.');
        return;
      }
      // Supersede any in-flight matrix so its now-stale results stop arriving.
      matrixCancel?.();
      matrixCancel = null;

      this.matrixState = 'running';
      // Clear the previous matrix so a new run starts from a blank map and fills in as links land.
      this.matrixResult = null;
      this.redrawLinks();

      const preset = this.splatParams.lora?.preset ?? 'LongFast';
      const sensitivity = this._simSensitivity();
      const sensitivityRounded = Math.round(sensitivity * 100) / 100;
      const nodeIds = this.nodes.map((n) => n.id);
      const nodes: SimNode[] = this.nodes.map((n) => ({
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

      const applyLinks = (links: LinkResult[]) => {
        this.matrixResult = { nodes: nodeIds, preset, sensitivity_dbm: sensitivityRounded, links };
        this.redrawLinks();
      };

      this.progress = { message: 'Fetching terrain…', fraction: 0 };
      const { promise, cancel } = runMatrixWorker({
        source: this._simSource(),
        nodes,
        shared: this._simShared(),
        sensitivity,
        quality: this._simQuality(),
        // ?? true: mergeDefaults is shallow, so params stored before this key existed lack it.
        filterHorizon: this.splatParams.simulation.filter_radio_horizon ?? true,
        onHeightmapProgress: (loaded, total) => {
          this.progress = { message: `Loading terrain ${loaded}/${total}…`, fraction: total ? 0.5 * (loaded / total) : 0 };
        },
        onProgress: (links, done, total) => {
          applyLinks(links);
          this.progress = { message: `Analysing link ${done}/${total}…`, fraction: 0.5 + (total ? 0.5 * (done / total) : 0) };
        },
      });
      matrixCancel = cancel;

      try {
        applyLinks(await promise);
        this.matrixState = 'completed';
        this.progress = null;
      } catch (error) {
        // A cancelled run was superseded by a newer one — let that newer run own the state.
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Matrix error:', error);
        this.matrixState = 'failed';
        this.progress = null;
      } finally {
        if (matrixCancel === cancel) {
          matrixCancel = null;
        }
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

      const sensitivity = this._simSensitivity();
      // tx carries the radio params (power/gain/freq); matching the old /profile payload, it also
      // takes the RX node's loss as system_loss. rx carries only position/height/rx_gain.
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
        quality: this._simQuality(),
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
    // Find the candidate relay zone between two nodes entirely in the browser (WASM ITM), replacing
    // the old /relay round-trip. Runs two coverage passes (one per endpoint) over a SHARED bbox so
    // their grids align, then intersects them per-cell: every location that hears both A and B above
    // sensitivity (plus the hypothetical relay's rx gain) is a candidate site.
    async runRelay(aId: string, bId: string) {
      const a = this.nodes.find((n) => n.id === aId);
      const b = this.nodes.find((n) => n.id === bId);
      if (!a || !b || a.id === b.id) {
        console.warn('Relay finder needs two distinct nodes.');
        return;
      }

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

      // The hypothetical relay's receive antenna height (m AGL). The old /relay flow ran each
      // endpoint's coverage pass at rx_height=2.0 (app/services/splat.py); mirror that here so the
      // two grids predict the signal at the same relay antenna height the server assumed.
      const RELAY_RX_HEIGHT_M = 2.0;

      // Per-site search radius (m), the old RelayRequest.search_radius_m default basis: the simulation
      // extent in km. Capped at 100 km like coverage so one search can't request a continent of terrain.
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
        // The old RelayRequest used node A's receiver gain as the hypothetical relay rx gain.
        relay_rx_gain: a.receiver.rx_gain,
        band_edges_db: [0.0, 10.0, 20.0], // RelayRequest.band_edges_db default
        top_n: 5, // RelayRequest.top_n default
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

        // Drape the margin grid as a smooth heatmap through the SAME pipeline coverage uses, so the
        // relay zone reads like a coverage overlay (continuous colour + soft FADE_BAND edge) instead
        // of the old blocky banded polygons. The grid carries margin (dB), not dBm, but colorizeGrid
        // is value-agnostic. Range 0..peak uses the full colour ramp; floor the peak so a low-margin
        // zone isn't washed out by a degenerate span.
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
      // NOT isStyleLoaded() (reads false while the slow sim-terrain tiles stream, which would drop the
      // relay result); the guards below suffice — adding the source/layer only needs the anchor layer
      // to exist (style mutable), and setData only needs the points source. See [[maplibre-isstyleloaded]].
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
      // the layer/source to exist (guarded), not isStyleLoaded() — which reads false while sim-terrain
      // tiles stream. See [[maplibre-isstyleloaded]].
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
