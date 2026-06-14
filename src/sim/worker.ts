/// <reference lib="webworker" />
// The sim Web Worker: runs the CPU-bound ITM evaluations off the UI thread. The main thread fetches
// and decodes the terrain heightmap (that needs the DOM canvas, unavailable here) and transfers the
// raw Terrarium buffer in; this worker reconstructs the Heightmap and computes links/profiles.
//
// Coverage and relay handlers are added alongside these as those phases land; the dispatch is a
// simple switch on msg.type so new jobs are additive.

import type { Heightmap } from '../viewshed/heightmap.ts';
import type { LinkResult } from '../types.ts';
import { haversineM } from './profile.ts';
import { loadItm, type ItmModule } from './itm/index.ts';
import {
  computeLink, computeProfile, groundElevationM, radioHorizonKm,
  type SimNode, type SimShared,
} from './links.ts';
import { computeCoverage } from './coverage.ts';
import { relayOverlap, type RelayParams } from './relay.ts';
import type { CoverageNode, CoverageOptions } from './coverageTypes.ts';
import type { ProfileOptions } from './profile.ts';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

// The heightmap as it crosses the worker boundary: the decoded RGBA buffer plus the mosaic geometry
// sampleProfile/lngLatToMosaicPixel need. data is rebuilt as a Uint8Array view of the transferred buffer.
export interface WireHeightmap {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  west: number;
  north: number;
  east: number;
  south: number;
  z: number;
  originX: number;
  originY: number;
}

function rebuild(h: WireHeightmap): Heightmap {
  return {
    data: new Uint8Array(h.buffer),
    width: h.width, height: h.height,
    west: h.west, north: h.north, east: h.east, south: h.south,
    z: h.z, originX: h.originX, originY: h.originY,
    sourceKey: '',
  };
}

interface MatrixMsg {
  type: 'matrix';
  reqId: number;
  heightmap: WireHeightmap;
  nodes: SimNode[];
  shared: SimShared;
  sensitivity: number;
  quality: ProfileOptions;
  filterHorizon: boolean;
}
interface ProfileMsg {
  type: 'profile';
  reqId: number;
  heightmap: WireHeightmap;
  tx: SimNode;
  rx: SimNode;
  shared: SimShared;
  sensitivity: number;
  quality: ProfileOptions;
}
// opts carries the output bbox + grid size + rxHeight (NOT the heightmap, which travels separately
// so its buffer can be transferred independently of the small opts object).
interface CoverageMsg {
  type: 'coverage';
  reqId: number;
  heightmap: WireHeightmap;
  tx: CoverageNode;
  shared: SimShared;
  opts: CoverageOptions;
}
// Relay runs two coverage passes (one per endpoint) over the SAME opts, so the two grids align and
// relayOverlap can intersect them cell-for-cell. Both txA/txB and the shared opts travel here.
interface RelayMsg {
  type: 'relay';
  reqId: number;
  heightmap: WireHeightmap;
  txA: CoverageNode;
  txB: CoverageNode;
  shared: SimShared;
  opts: CoverageOptions;
  params: RelayParams;
}
type InMsg = MatrixMsg | ProfileMsg | CoverageMsg | RelayMsg;

let modPromise: Promise<ItmModule> | null = null;
const getMod = (): Promise<ItmModule> => (modPromise ??= loadItm());

const PROGRESS_MS = 200; // throttle progressive matrix emits

async function handleMatrix(msg: MatrixMsg): Promise<void> {
  const mod = await getMod();
  const hm = rebuild(msg.heightmap);
  const { nodes, shared, sensitivity, quality, filterHorizon, reqId } = msg;

  // Ground elevations (for the radio-horizon pre-filter) sampled once per node from this heightmap.
  const ground = filterHorizon ? nodes.map((n) => groundElevationM(hm, n)) : null;

  // Unordered pairs, pre-filtered by the LOS radio horizon when requested (mirrors run_matrix).
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (ground) {
        const distKm = haversineM(nodes[i].lon, nodes[i].lat, nodes[j].lon, nodes[j].lat) / 1000;
        const horizon = radioHorizonKm(ground[i] + nodes[i].height, ground[j] + nodes[j].height);
        if (distKm > horizon) {
          continue;
        }
      }
      pairs.push([i, j]);
    }
  }

  const links: LinkResult[] = [];
  const total = pairs.length;
  let lastEmit = 0;
  for (let k = 0; k < pairs.length; k++) {
    const [i, j] = pairs[k];
    links.push(computeLink(mod, hm, nodes[i], nodes[j], shared, sensitivity, quality));
    const now = performance.now();
    if (now - lastEmit >= PROGRESS_MS) {
      lastEmit = now;
      ctx.postMessage({ type: 'matrix-progress', reqId, links: links.slice(), done: k + 1, total });
    }
  }
  ctx.postMessage({ type: 'matrix-done', reqId, links, done: total, total });
}

async function handleProfile(msg: ProfileMsg): Promise<void> {
  const mod = await getMod();
  const hm = rebuild(msg.heightmap);
  try {
    const result = computeProfile(mod, hm, msg.tx, msg.rx, msg.shared, msg.sensitivity, msg.quality);
    ctx.postMessage({ type: 'profile-done', reqId: msg.reqId, result });
  } catch (err) {
    ctx.postMessage({ type: 'profile-error', reqId: msg.reqId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleCoverage(msg: CoverageMsg): Promise<void> {
  const mod = await getMod();
  const hm = rebuild(msg.heightmap);
  const { reqId } = msg;
  // computeCoverage emits once per completed row; the grid can be hundreds of rows, so gate the
  // cross-thread posts to ~once per 200ms (same throttle as the matrix handler) to keep the
  // main-thread progress updates cheap.
  let lastEmit = 0;
  const grid = computeCoverage(mod, hm, msg.tx, msg.shared, msg.opts, (done, total) => {
    const now = performance.now();
    if (now - lastEmit >= PROGRESS_MS) {
      lastEmit = now;
      ctx.postMessage({ type: 'coverage-progress', reqId, done, total });
    }
  });
  // Transfer the dbm buffer back rather than copy it: it can be megabytes for a large grid, and the
  // worker no longer needs it once the grid is built.
  ctx.postMessage(
    {
      type: 'coverage-done',
      reqId,
      grid: {
        buffer: grid.dbm.buffer,
        width: grid.width, height: grid.height,
        west: grid.west, south: grid.south, east: grid.east, north: grid.north,
      },
    },
    [grid.dbm.buffer],
  );
}

async function handleRelay(msg: RelayMsg): Promise<void> {
  const mod = await getMod();
  const hm = rebuild(msg.heightmap);
  const { reqId } = msg;
  try {
    // Both passes share msg.opts so their grids align (relayOverlap requires identical width/height/
    // bbox). The two row-progress streams are stitched into one 0..1 fraction: pass A fills the first
    // half, pass B the second, gated to ~200ms like the coverage handler.
    let lastEmit = 0;
    const emit = (fraction: number): void => {
      const now = performance.now();
      if (now - lastEmit >= PROGRESS_MS) {
        lastEmit = now;
        // Report against a 0..total scale so the main thread can drive a fraction without knowing the
        // two-pass split; total is fixed at the grid cell count, done sweeps 0..total across both passes.
        const total = msg.opts.width * msg.opts.height;
        ctx.postMessage({ type: 'relay-progress', reqId, done: Math.round(fraction * total), total });
      }
    };
    const gridA = computeCoverage(mod, hm, msg.txA, msg.shared, msg.opts, (done, total) => {
      emit(0.5 * (total ? done / total : 0));
    });
    const gridB = computeCoverage(mod, hm, msg.txB, msg.shared, msg.opts, (done, total) => {
      emit(0.5 + 0.5 * (total ? done / total : 0));
    });
    const result = relayOverlap(gridA, gridB, msg.params);
    // RelayResult is plain JSON (GeoJSON FeatureCollections); no transferable buffers to hand back.
    ctx.postMessage({ type: 'relay-done', reqId, result });
  } catch (err) {
    ctx.postMessage({ type: 'relay-error', reqId, error: err instanceof Error ? err.message : String(err) });
  }
}

ctx.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === 'matrix') {
    void handleMatrix(msg);
  } else if (msg.type === 'profile') {
    void handleProfile(msg);
  } else if (msg.type === 'coverage') {
    void handleCoverage(msg);
  } else if (msg.type === 'relay') {
    void handleRelay(msg);
  }
};
