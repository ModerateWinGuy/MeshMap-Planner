import { defineStore } from 'pinia';
import { useLocalStorage } from '@vueuse/core';
import { watch, markRaw } from 'vue';
import { randanimalSync } from 'randanimal';
import maplibregl from 'maplibre-gl';
import parseGeoraster from 'georaster';
import { type Site, type SplatParams, type Node, type MatrixResult, type RelayResult, type UiMode } from './types.ts';
import { cloneObject, escapeHtml } from './utils.ts';
import { makePinElement, stylePinElement } from './layers.ts';

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
function linkColor(margin: number | null): string {
  if (margin === null || margin === undefined) {
    return '#888888';
  }
  const t = Math.max(0, Math.min(1, margin / 30)); // saturate at +30 dB margin
  const r = Math.round(220 * (1 - t));
  const g = Math.round(40 + 150 * t);
  return `rgb(${r}, ${g}, 50)`;
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

// The raster-dem source backing both the 3D terrain mesh and the hillshade, chosen by terrain_source:
//   'srtm' → AWS Terrarium directly (global bare-earth baseline, no backend dependency)
//   'dem'/'dsm' → our backend tile endpoint, which serves LINZ LIDAR over NZ and redirects to
//                 Terrarium elsewhere — so the rendered terrain matches the RF simulation's choice.
function terrainDemSource(terrainSource: string, config: TerrainConfig): any {
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
  sources['terrain-dem'] = terrainDemSource(terrainSource, terrainConfig);
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
      // 3D terrain (draped from the terrain raster-dem). Persisted so the view survives a reload.
      terrainEnabled: useLocalStorage('terrainEnabled', false),
      terrainExaggeration: useLocalStorage('terrainExaggeration', 1),
      // Zoom band for the terrain source, fetched from GET /terrain/config in initMap. In-memory only
      // (it's a backend deployment fact, not a user setting); defaults match the backend so the map
      // works before/without the fetch.
      terrainConfig: { ...DEFAULT_TERRAIN_CONFIG } as TerrainConfig,
      // Progress of a "download terrain for this view" prefetch (null when idle). In-memory only.
      terrainDownload: null as null | { running: boolean; done: number; total: number; cancelled: boolean; tooLarge: boolean },
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
          terrain_source: 'srtm'
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
    }
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
    },
    selectNode(id: string) {
      this.selectedNodeId = id;
      this.renderNodeMarkers();
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
      if (this.selectedNodeId === id) {
        this.selectedNodeId = this.nodes[0]?.id ?? null;
      }
      this.renderNodeMarkers();
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
            this.selectNode(node.id);
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
      if (!map || !map.isStyleLoaded()) {
        return; // re-run from the 'load' handler once the style is ready
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
      if (!map || !map.isStyleLoaded()) {
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
          ),
          center,
          zoom: 10,
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

      this.wireOverlayPopups();
    },
    wireOverlayPopups() {
      const map = this.map as maplibregl.Map | undefined;
      if (!map) {
        return;
      }
      // Read-only info popups for links + relay zone.
      for (const layer of ['links-solid', 'links-dashed', 'relay-zone-fill']) {
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
    // Re-point the terrain raster-dem at the tile endpoint for the current terrain_source ('dem' vs
    // 'dsm'). MapLibre can't mutate a source's url/maxzoom in place, so swap the source: detach
    // terrain, drop the hillshade layer (it references the source), remove + re-add the source with
    // the new url and per-source maxzoom, then restore hillshade and re-attach terrain.
    swapTerrainSource() {
      const map = this.map as maplibregl.Map | undefined;
      // Gate on an overlay layer existing, which means setupOverlays (on 'load') has run: removeSource
      // /addSource need a loaded style, and we re-add the hillshade it created. Before load the source
      // was just built by buildStyle with the current terrain_source, so there's nothing to swap yet.
      if (!map || !map.getLayer('relay-zone-fill')) {
        return;
      }
      const source = this.splatParams.simulation.terrain_source;
      map.setTerrain(null); // detach before removing — MapLibre errors on removing a live terrain source
      if (map.getLayer('hillshade')) {
        map.removeLayer('hillshade');
      }
      map.removeSource('terrain-dem');
      map.addSource('terrain-dem', terrainDemSource(source, this.terrainConfig));
      // Re-add hillshade just below the data overlays (relay-zone-fill is the lowest) so it can't cover them.
      this.addHillshadeLayer(map, 'relay-zone-fill');
      this.applyTerrain();
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
      if (!map || !map.isStyleLoaded()) {
        return;
      }
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
      for (const link of this.matrixResult.links) {
        const a = byId[link.a];
        const b = byId[link.b];
        if (!a || !b) {
          continue; // node was deleted since the matrix ran
        }
        const details = link.error
          ? `Error: ${escapeHtml(link.error)}`
          : `Margin: ${link.margin_db ?? '—'} dB<br>` +
            `Path loss: ${link.path_loss_db ?? '—'} dB<br>` +
            `Fresnel zone: ${link.fresnel_pct ?? '—'} % clear<br>` +
            `Distance: ${link.distance_km ?? '—'} km`;
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
            popupHtml: `<strong>${escapeHtml(a.transmitter.name)} ↔ ${escapeHtml(b.transmitter.name)}</strong><br>${details}`,
          },
        });
      }
      src.setData({ type: 'FeatureCollection', features } as any);
    },
    async runMatrix() {
      if (this.nodes.length < 2) {
        console.warn('Need at least 2 nodes to compute a link matrix.');
        return;
      }
      try {
        this.matrixState = 'running';
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
          terrain_source: this.splatParams.simulation.terrain_source
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
          if (statusData.status === 'completed') {
            const resultResponse = await fetch(`/matrix/result/${taskId}`);
            if (!resultResponse.ok) {
              throw new Error('Failed to fetch matrix result.');
            }
            this.matrixResult = await resultResponse.json();
            this.matrixState = 'completed';
            this.redrawLinks();
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
      if (!map || !map.isStyleLoaded()) {
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
      if (map && map.isStyleLoaded()) {
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
    }
  }
});

export { useStore }
