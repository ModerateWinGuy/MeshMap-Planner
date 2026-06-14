// Main-thread façade over the sim Web Worker. The DOM-bound terrain fetch (getHeightmap needs a
// canvas) happens here; the CPU-bound ITM runs in the worker. Callers (the store) hand in the
// resolved tile source + nodes/params and get progressive link results or a profile.
//
// The heightmap buffer is structured-cloned (not transferred) into the worker so getHeightmap's LRU
// cache keeps an intact copy for the next call.

import { getHeightmap, type Heightmap } from '../viewshed/heightmap.ts';
import { haversineM } from './profile.ts';
import type { ProfileOptions } from './profile.ts';
import type { SimNode, SimShared } from './links.ts';
import type { CoverageNode, CoverageGrid, CoverageOptions } from './coverageTypes.ts';
import type { RelayParams } from './relay.ts';
import type { LinkResult, ProfileResult, RelayResult } from '../types.ts';
import type { WireHeightmap } from './worker.ts';

// The active terrain tile source, resolved by the store from terrainDemSource() + the map's zoom.
export interface SimSource {
  urlTemplate: string; // a {z}/{x}/{y} tile template (the AWS Terrarium URL)
  maxzoom: number; // served cap for this source
  mapZoom: number; // the map's current zoom (tiles fetched here match what the map shows)
}

export interface MatrixRun {
  source: SimSource;
  nodes: SimNode[];
  shared: SimShared;
  sensitivity: number;
  filterHorizon: boolean;
  quality?: ProfileOptions;
  onProgress?: (links: LinkResult[], done: number, total: number) => void;
  onHeightmapProgress?: (loaded: number, total: number) => void;
}

export interface ProfileRun {
  source: SimSource;
  tx: SimNode;
  rx: SimNode;
  shared: SimShared;
  sensitivity: number;
  quality?: ProfileOptions;
  onHeightmapProgress?: (loaded: number, total: number) => void;
}

export interface CoverageRun {
  source: SimSource;
  tx: CoverageNode;
  shared: SimShared;
  radiusM: number; // half-extent of the square output bbox around tx; also the radial sweep disc radius
  gridSize: number; // OUTPUT raster is gridSize × gridSize cells (rasterization target, cheap)
  rxHeightM: number; // receiver AGL tested at every cell
  azimuths?: number; // radial sweep rays (ITM cost ≈ az × rangeSteps²/2)
  rangeSteps?: number; // radial sweep samples per ray from the TX to radiusM
  quality?: ProfileOptions; // legacy per-path fidelity, unused by the radial sweep (kept for relay/back-compat)
  onProgress?: (done: number, total: number) => void;
  onHeightmapProgress?: (loaded: number, total: number) => void;
}

// Relay siting: two coverage passes (txA, txB) over a shared opts (so their grids align), intersected
// by relayOverlap. The caller builds the opts bbox; one heightmap covers the whole of it.
export interface RelayRun {
  source: SimSource;
  txA: CoverageNode;
  txB: CoverageNode;
  shared: SimShared;
  opts: CoverageOptions;
  params: RelayParams;
  onProgress?: (done: number, total: number) => void;
  onHeightmapProgress?: (loaded: number, total: number) => void;
}

let worker: Worker | null = null;
let reqCounter = 0;
const matrixHandlers = new Map<number, { onProgress?: MatrixRun['onProgress']; resolve: (l: LinkResult[]) => void; reject: (e: unknown) => void }>();
const profileHandlers = new Map<number, { resolve: (r: ProfileResult) => void; reject: (e: unknown) => void }>();
const coverageHandlers = new Map<number, { onProgress?: CoverageRun['onProgress']; resolve: (g: CoverageGrid) => void; reject: (e: unknown) => void }>();
const relayHandlers = new Map<number, { onProgress?: RelayRun['onProgress']; resolve: (r: RelayResult) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      switch (m.type) {
        case 'matrix-progress':
          matrixHandlers.get(m.reqId)?.onProgress?.(m.links, m.done, m.total);
          break;
        case 'matrix-done': {
          const h = matrixHandlers.get(m.reqId);
          matrixHandlers.delete(m.reqId);
          h?.resolve(m.links);
          break;
        }
        case 'profile-done': {
          const h = profileHandlers.get(m.reqId);
          profileHandlers.delete(m.reqId);
          h?.resolve(m.result);
          break;
        }
        case 'profile-error': {
          const h = profileHandlers.get(m.reqId);
          profileHandlers.delete(m.reqId);
          h?.reject(new Error(m.error));
          break;
        }
        case 'coverage-progress':
          coverageHandlers.get(m.reqId)?.onProgress?.(m.done, m.total);
          break;
        case 'coverage-done': {
          const h = coverageHandlers.get(m.reqId);
          coverageHandlers.delete(m.reqId);
          // Reconstruct the typed-array view over the transferred buffer; the geometry rides alongside.
          h?.resolve({
            dbm: new Float32Array(m.grid.buffer),
            width: m.grid.width, height: m.grid.height,
            west: m.grid.west, south: m.grid.south, east: m.grid.east, north: m.grid.north,
          });
          break;
        }
        case 'relay-progress':
          relayHandlers.get(m.reqId)?.onProgress?.(m.done, m.total);
          break;
        case 'relay-done': {
          const h = relayHandlers.get(m.reqId);
          relayHandlers.delete(m.reqId);
          h?.resolve(m.result);
          break;
        }
        case 'relay-error': {
          const h = relayHandlers.get(m.reqId);
          relayHandlers.delete(m.reqId);
          h?.reject(new Error(m.error));
          break;
        }
      }
    };
  }
  return worker;
}

function wire(hm: Heightmap): WireHeightmap {
  return {
    buffer: hm.data.buffer,
    width: hm.width, height: hm.height,
    west: hm.west, north: hm.north, east: hm.east, south: hm.south,
    z: hm.z, originX: hm.originX, originY: hm.originY,
  };
}

// Square fetch region (centre + half-extent metres) covering a set of points, with a floor so a
// tight cluster still fetches a usable mosaic. getHeightmap pads this further (FETCH_PAD).
function coveringRegion(pts: Array<{ lon: number; lat: number }>): { lon: number; lat: number; radiusM: number } {
  const lons = pts.map((p) => p.lon);
  const lats = pts.map((p) => p.lat);
  const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  let radiusM = 1000;
  for (const p of pts) {
    radiusM = Math.max(radiusM, haversineM(lon, lat, p.lon, p.lat));
  }
  return { lon, lat, radiusM };
}

// Run a full link matrix. Returns a cancel handle: cancel() drops the result routing so a superseded
// run (e.g. a node was dragged again) neither fires onProgress nor resolves.
export function runMatrix(run: MatrixRun): { promise: Promise<LinkResult[]>; cancel: () => void } {
  const reqId = ++reqCounter;
  const region = coveringRegion(run.nodes);
  const promise = (async (): Promise<LinkResult[]> => {
    const hm = await getHeightmap(
      { urlTemplate: run.source.urlTemplate, maxzoom: run.source.maxzoom, lon: region.lon, lat: region.lat, radiusM: region.radiusM, mapZoom: run.source.mapZoom },
      run.onHeightmapProgress ? (p) => run.onHeightmapProgress!(p.loaded, p.total) : undefined,
    );
    return new Promise<LinkResult[]>((resolve, reject) => {
      matrixHandlers.set(reqId, { onProgress: run.onProgress, resolve, reject });
      getWorker().postMessage({
        type: 'matrix', reqId, heightmap: wire(hm),
        nodes: run.nodes, shared: run.shared, sensitivity: run.sensitivity,
        quality: run.quality ?? {}, filterHorizon: run.filterHorizon,
      });
    });
  })();
  const cancel = (): void => {
    const h = matrixHandlers.get(reqId);
    if (h) {
      matrixHandlers.delete(reqId);
      h.reject(new DOMException('cancelled', 'AbortError'));
    }
  };
  return { promise, cancel };
}

// Run a single point-to-point profile.
export function runProfile(run: ProfileRun): { promise: Promise<ProfileResult>; cancel: () => void } {
  const reqId = ++reqCounter;
  const region = coveringRegion([{ lon: run.tx.lon, lat: run.tx.lat }, { lon: run.rx.lon, lat: run.rx.lat }]);
  const promise = (async (): Promise<ProfileResult> => {
    const hm = await getHeightmap(
      { urlTemplate: run.source.urlTemplate, maxzoom: run.source.maxzoom, lon: region.lon, lat: region.lat, radiusM: region.radiusM, mapZoom: run.source.mapZoom },
      run.onHeightmapProgress ? (p) => run.onHeightmapProgress!(p.loaded, p.total) : undefined,
    );
    return new Promise<ProfileResult>((resolve, reject) => {
      profileHandlers.set(reqId, { resolve, reject });
      getWorker().postMessage({
        type: 'profile', reqId, heightmap: wire(hm),
        tx: run.tx, rx: run.rx, shared: run.shared, sensitivity: run.sensitivity, quality: run.quality ?? {},
      });
    });
  })();
  const cancel = (): void => {
    const h = profileHandlers.get(reqId);
    if (h) {
      profileHandlers.delete(reqId);
      h.reject(new DOMException('cancelled', 'AbortError'));
    }
  };
  return { promise, cancel };
}

// Run a client-side coverage pass: one ITM evaluation per output cell of a gridSize² lon/lat bbox
// centred on tx. Returns a cancel handle that supersedes the run exactly like runMatrix.
export function runCoverage(run: CoverageRun): { promise: Promise<CoverageGrid>; cancel: () => void } {
  const reqId = ++reqCounter;
  // Square bbox of half-extent radiusM around tx. dLon widens with latitude (a degree of longitude
  // shrinks toward the poles); the cos floor keeps the divisor finite near the poles.
  const dLat = run.radiusM / 111320;
  const dLon = run.radiusM / (111320 * Math.max(0.01, Math.cos(run.tx.lat * Math.PI / 180)));
  const west = run.tx.lon - dLon;
  const east = run.tx.lon + dLon;
  const south = run.tx.lat - dLat;
  const north = run.tx.lat + dLat;
  const opts: CoverageOptions = {
    west, south, east, north,
    width: run.gridSize, height: run.gridSize,
    rxHeightM: run.rxHeightM, quality: run.quality,
    // Radial sweep: the disc radius is the same radiusM the bbox was built from. The worker forwards
    // opts to computeCoverage unchanged, so threading them here is all that's needed.
    radiusM: run.radiusM, azimuths: run.azimuths, rangeSteps: run.rangeSteps,
  };
  const promise = (async (): Promise<CoverageGrid> => {
    const hm = await getHeightmap(
      { urlTemplate: run.source.urlTemplate, maxzoom: run.source.maxzoom, lon: run.tx.lon, lat: run.tx.lat, radiusM: run.radiusM, mapZoom: run.source.mapZoom },
      run.onHeightmapProgress ? (p) => run.onHeightmapProgress!(p.loaded, p.total) : undefined,
    );
    return new Promise<CoverageGrid>((resolve, reject) => {
      coverageHandlers.set(reqId, { onProgress: run.onProgress, resolve, reject });
      getWorker().postMessage({
        type: 'coverage', reqId, heightmap: wire(hm),
        tx: run.tx, shared: run.shared, opts,
      });
    });
  })();
  const cancel = (): void => {
    const h = coverageHandlers.get(reqId);
    if (h) {
      coverageHandlers.delete(reqId);
      h.reject(new DOMException('cancelled', 'AbortError'));
    }
  };
  return { promise, cancel };
}

// Run a client-side relay search: two coverage passes over run.opts (so the grids align), intersected
// in the worker by relayOverlap. One heightmap is fetched covering the whole opts bbox — centred on
// the bbox centre with a half-diagonal radius (to the NE corner) so the fetch reaches every cell.
// Returns a cancel handle that supersedes the run exactly like runCoverage.
export function runRelay(run: RelayRun): { promise: Promise<RelayResult>; cancel: () => void } {
  const reqId = ++reqCounter;
  const { west, south, east, north } = run.opts;
  const lon = (west + east) / 2;
  const lat = (south + north) / 2;
  const radiusM = haversineM(lon, lat, east, north); // half-diagonal of the bbox
  const promise = (async (): Promise<RelayResult> => {
    const hm = await getHeightmap(
      { urlTemplate: run.source.urlTemplate, maxzoom: run.source.maxzoom, lon, lat, radiusM, mapZoom: run.source.mapZoom },
      run.onHeightmapProgress ? (p) => run.onHeightmapProgress!(p.loaded, p.total) : undefined,
    );
    return new Promise<RelayResult>((resolve, reject) => {
      relayHandlers.set(reqId, { onProgress: run.onProgress, resolve, reject });
      getWorker().postMessage({
        type: 'relay', reqId, heightmap: wire(hm),
        txA: run.txA, txB: run.txB, shared: run.shared, opts: run.opts, params: run.params,
      });
    });
  })();
  const cancel = (): void => {
    const h = relayHandlers.get(reqId);
    if (h) {
      relayHandlers.delete(reqId);
      h.reject(new DOMException('cancelled', 'AbortError'));
    }
  };
  return { promise, cancel };
}
