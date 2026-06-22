// Main-thread façade over the sim Web Worker. The DOM-bound terrain fetch (getHeightmap needs a
// canvas) happens here; the CPU-bound ITM runs in the worker. Callers (the store) hand in the
// resolved tile source + nodes/params and get progressive link results or a profile.
//
// The heightmap buffer is structured-cloned (not transferred) into the worker so getHeightmap's LRU
// cache keeps an intact copy for the next call.

import { getHeightmap, getCorridor, getLodHeightmap, type Heightmap, type LodHeightmap } from '../viewshed/heightmap.ts';
import { type OverlaySpec } from '../terrain/demTiles.ts';
import { haversineM, sampleProfileCorridor, sampleProfileLod, type ProfileSample } from './profile.ts';
import type { ProfileOptions } from './profile.ts';
import { groundElevationM, radioHorizonKm, type SimNode, type SimShared } from './links.ts';
import type { CoverageNode, CoverageGrid, CoverageOptions } from './coverageTypes.ts';
import type { RelayParams } from './relay.ts';
import type { LinkResult, ProfileResult, RelayResult } from '../types.ts';
import type { WireHeightmap, WireLodHeightmap } from './worker.ts';

// The active terrain tile source, resolved by the store from the map's zoom + overlay state.
export interface SimSource {
  urlTemplate: string; // the Mapterhorn baseline {z}/{x}/{y} template (composited from, not meshdem://)
  overlays: OverlaySpec[]; // higher-detail overlays composited over the baseline (LINZ when on; [] = off)
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
  // When set, compute only the pairs touching this node, with it as TX (the line-profile direction) — the
  // fast interactive path. When omitted, the full N² matrix is computed.
  sourceNodeId?: string;
  // Hard distance cap (km) applied to the FULL matrix only (ignored when sourceNodeId is set). 0/undefined
  // = no cap. Lets a dense map skip long, marginal pairs the horizon would otherwise allow.
  maxDistanceKm?: number;
  // Fired once per link as it lands, so the store can merge it into the matrix and redraw progressively.
  onLink?: (link: LinkResult, done: number, total: number) => void;
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
// Per-LINK request map: each pipelined matrix link posts a `matrix-link` to the worker keyed by a fresh
// id and resolves here on `matrix-link-done` (mirrors profileHandlers, one entry per pair in flight).
let linkSeq = 0;
const matrixLinkHandlers = new Map<number, (link: LinkResult) => void>();
const profileHandlers = new Map<number, { resolve: (r: ProfileResult) => void; reject: (e: unknown) => void }>();
const coverageHandlers = new Map<number, { onProgress?: CoverageRun['onProgress']; resolve: (g: CoverageGrid) => void; reject: (e: unknown) => void }>();
const relayHandlers = new Map<number, { onProgress?: RelayRun['onProgress']; resolve: (r: RelayResult) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      switch (m.type) {
        case 'matrix-link-done': {
          const resolve = matrixLinkHandlers.get(m.id);
          matrixLinkHandlers.delete(m.id);
          resolve?.(m.link);
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

// Wire the coverage LOD stack: each level is a wired Heightmap plus its inscribed radius (the sampler's
// level-pick key). Buffers are cloned, not transferred (no transfer list on the postMessage), so each
// level's getHeightmap LRU copy stays intact for the next run — same trade-off as the single square.
function wireLod(lod: LodHeightmap): WireLodHeightmap {
  return {
    levels: lod.levels.map((l) => ({ ...wire(l.hm), innerRadiusM: l.innerRadiusM })),
    lon: lod.lon, lat: lod.lat,
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

// Reorder nodes along a Z-order (Morton) curve so consecutive nodes are spatial neighbours: the O(N²)
// matrix sweep then revisits each node's discs/tiles close in time, letting the disc/tile LRUs catch
// reuse. Returns a new array (does not mutate the input). Quantizes normalized web-mercator coords to
// 16 bits per axis and interleaves them into a 32-bit code.
function spatialSort(nodes: SimNode[]): SimNode[] {
  const MORTON_MAX_LAT = 85.05112878;
  // Spread the low 16 bits of v across the even bit positions (so two such values OR together interleaved).
  const part1by1 = (v: number): number => {
    v &= 0xffff;
    v = (v | (v << 8)) & 0x00ff00ff;
    v = (v | (v << 4)) & 0x0f0f0f0f;
    v = (v | (v << 2)) & 0x33333333;
    v = (v | (v << 1)) & 0x55555555;
    return v;
  };
  const morton = (n: SimNode): number => {
    const r = (Math.max(-MORTON_MAX_LAT, Math.min(MORTON_MAX_LAT, n.lat)) * Math.PI) / 180;
    const x = (n.lon + 180) / 360;
    const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
    const qx = Math.max(0, Math.min(65535, Math.floor(x * 65535)));
    const qy = Math.max(0, Math.min(65535, Math.floor(y * 65535)));
    // >>> 0 keeps the result an unsigned 32-bit int (the high bit set by interleaving would read negative).
    return ((part1by1(qx) | (part1by1(qy) << 1)) >>> 0);
  };
  return nodes
    .map((n) => ({ n, code: morton(n) }))
    .sort((a, b) => a.code - b.code)
    .map((e) => e.n);
}

// Near-field radius (m): full detail within 1.5 km of each endpoint (where LOS clipping happens at the
// antenna), coarse base square beyond. The disc stays at full zoom (the resolution that matters for
// antenna-local obstructions); the radius is the primary accuracy↔speed tunable — tiles scale with
// radius², so trimming it cuts each node's disc footprint sharply. A short link (< 2×) is all
// near-field, so full detail end-to-end.
const NEAR_R_M = 1500;
// Per-run cache of hi-res endpoint discs, keyed by node id (stores the in-flight promise, so concurrent
// pairs needing the same node share one fetch). The matrix sweep is spatially ordered (spatialSort), so
// each node's spatial neighbourhood is processed close in time and a modest LRU now actually catches
// reuse. Capped because each cached disc holds its full mosaic bytes (a few MB each).
const DISC_CACHE_MAX = 64;
// Links in flight (each: fetch ≤2 discs, sample, one worker ITM round-trip). The worker step is cheap, so
// this mainly bounds concurrent disc tile fetches.
const LINK_POOL = 6;

// Run `fn` over `items` with at most `concurrency` in flight, preserving result order. Stops pulling new
// work once `signal` aborts (in-flight calls settle on their own); the caller discards the partial
// result. Local to the matrix — the only fan-out fetch that needs it.
async function mapPool<T, R>(
  items: T[], concurrency: number, signal: AbortSignal, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      if (signal.aborted) {
        return;
      }
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// One hi-res endpoint disc (full-zoom square ~NEAR_R_M around a node), cached per run by node id. The
// cache holds the in-flight PROMISE so concurrent pairs needing the same node await a single fetch (the
// composited-tile cache then dedupes shared tiles between neighbouring discs too).
function getDisc(cache: Map<string, Promise<Heightmap>>, source: SimSource, node: SimNode): Promise<Heightmap> {
  const cached = cache.get(node.id);
  if (cached) {
    cache.delete(node.id);
    cache.set(node.id, cached); // LRU bump
    return cached;
  }
  const p = getHeightmap({
    urlTemplate: source.urlTemplate, overlays: source.overlays, maxzoom: source.maxzoom,
    lon: node.lon, lat: node.lat, radiusM: NEAR_R_M, mapZoom: source.maxzoom, // mapZoom=maxzoom → full zoom
  });
  cache.set(node.id, p);
  while (cache.size > DISC_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return p;
}

// Compute one link in the worker from its already-sampled profile; resolves when the worker posts back.
// The heights buffer is transferred (the worker rebuilds the Float64Array over it).
function computeLinkInWorker(
  sample: ProfileSample, tx: SimNode, rx: SimNode, shared: SimShared, sensitivity: number,
): Promise<LinkResult> {
  const id = ++linkSeq;
  return new Promise<LinkResult>((resolve) => {
    matrixLinkHandlers.set(id, resolve);
    getWorker().postMessage(
      {
        type: 'matrix-link', id,
        sample: {
          heightsBuffer: sample.heights.buffer,
          spacingM: sample.spacingM, distanceM: sample.distanceM, terrain: sample.terrain,
        },
        tx, rx, shared, sensitivity,
      },
      [sample.heights.buffer],
    );
  });
}

// 20·log10(4π/c) with distance in km and frequency in MHz — the constant term of free-space path loss.
const FSPL_KM_MHZ_CONST = 32.44778;
// The farthest a tx->rx link could possibly close given its budget: FSPL is the FLOOR on path loss
// (terrain/clutter only ever add to it), so beyond this range margin >= 0 is impossible and the pair is
// dropped before any terrain fetch. Lossless — it never prunes a link that could actually close. A
// missing/zero frequency can't be bounded, so it returns Infinity (no prune). Budget mirrors
// evaluateSample: erp(tx) + rx_gain - sensitivity is the max path loss the link tolerates.
function maxBudgetRangeKm(tx: SimNode, rx: SimNode, sensitivity: number): number {
  if (!(tx.frequency_mhz > 0)) {
    return Infinity;
  }
  const maxLossDb = tx.tx_power + tx.tx_gain - tx.system_loss + rx.rx_gain - sensitivity;
  return 10 ** ((maxLossDb - 20 * Math.log10(tx.frequency_mhz) - FSPL_KM_MHZ_CONST) / 20);
}

// The viable node pairs for a run, pre-filtered so impossible links never reach the (expensive) terrain
// fetch: a pair survives only if it's within both the geometric LOS horizon (when the base square is
// available for ground elevation) AND its link budget's free-space range. The first index is always TX,
// so both gates use the direction actually computed. With sourceNodeId set, only pairs touching that
// node, with it as TX (the line-profile direction); otherwise every unordered pair. base=null skips just
// the horizon gate (the budget gate is always lossless, so it still applies).
function buildPairs(
  nodes: SimNode[], sourceNodeId: string | undefined, base: Heightmap | null,
  sensitivity: number, maxDistanceKm: number,
): Array<[number, number]> {
  const ground = base ? nodes.map((n) => groundElevationM(base, n)) : null;
  // capKm: an extra hard distance gate, only meaningful for the full matrix; Infinity disables it.
  const feasible = (t: number, r: number, capKm: number): boolean => {
    const distKm = haversineM(nodes[t].lon, nodes[t].lat, nodes[r].lon, nodes[r].lat) / 1000;
    if (distKm > capKm) {
      return false;
    }
    if (ground && distKm > radioHorizonKm(ground[t] + nodes[t].height, ground[r] + nodes[r].height)) {
      return false;
    }
    return distKm <= maxBudgetRangeKm(nodes[t], nodes[r], sensitivity);
  };
  const pairs: Array<[number, number]> = [];
  if (sourceNodeId !== undefined) {
    const s = nodes.findIndex((n) => n.id === sourceNodeId);
    if (s < 0) {
      return pairs;
    }
    // Per-node: exhaustive within horizon + budget (one node's links are cheap), so no distance cap.
    for (let j = 0; j < nodes.length; j++) {
      if (j !== s && feasible(s, j, Infinity)) {
        pairs.push([s, j]); // s = TX
      }
    }
  } else {
    const capKm = maxDistanceKm > 0 ? maxDistanceKm : Infinity;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (feasible(i, j, capKm)) {
          pairs.push([i, j]);
        }
      }
    }
  }
  return pairs;
}

// Run the link matrix as a streaming pipeline: build the viable pair list, then for each pair fetch its
// two hi-res endpoint discs, sample TX->RX against those + the shared coarse base (full detail near the
// ends, coarse in the middle), and run ITM — all bounded by LINK_POOL, so links land one-by-one
// (run.onLink) as their terrain arrives instead of in one bulk fetch. With run.sourceNodeId set it
// computes only that node's links (the fast interactive path). Returns a cancel handle: cancel() stops
// launching new pairs and makes the promise reject, so a superseded run is dropped.
export function runMatrix(run: MatrixRun): { promise: Promise<void>; cancel: () => void } {
  const ctrl = new AbortController();
  const discCache = new Map<string, Promise<Heightmap>>();
  const promise = (async (): Promise<void> => {
    // Spatially order the sweep once so neighbouring nodes are processed close in time (disc/tile reuse).
    // Safe: each LinkResult carries its endpoint ids and the store upserts by id, so reordering only
    // changes the order links stream in, not their identity or values. Per-node mode finds its source by
    // id within this array.
    const nodes = spatialSort(run.nodes);
    // One coarse square covering all nodes: the span middle of every link AND the horizon-filter ground.
    const region = coveringRegion(run.nodes);
    const base = await getHeightmap({
      urlTemplate: run.source.urlTemplate, overlays: run.source.overlays, maxzoom: run.source.maxzoom,
      lon: region.lon, lat: region.lat, radiusM: region.radiusM, mapZoom: run.source.mapZoom,
    });
    if (ctrl.signal.aborted) {
      throw new DOMException('cancelled', 'AbortError');
    }
    const pairs = buildPairs(nodes, run.sourceNodeId, run.filterHorizon ? base : null, run.sensitivity, run.maxDistanceKm ?? 0);
    const total = pairs.length;
    if (total === 0) {
      return;
    }
    let done = 0;
    await mapPool(pairs, LINK_POOL, ctrl.signal, async ([i, j]) => {
      const tx = nodes[i];
      const rx = nodes[j];
      let link: LinkResult | null = null;
      try {
        const [discA, discB] = await Promise.all([
          getDisc(discCache, run.source, tx),
          getDisc(discCache, run.source, rx),
        ]);
        if (ctrl.signal.aborted) {
          return;
        }
        const sample = sampleProfileLod(discA, discB, base, tx.lon, tx.lat, rx.lon, rx.lat, NEAR_R_M, run.quality ?? {});
        link = await computeLinkInWorker(sample, tx, rx, run.shared, run.sensitivity);
      } catch (err) {
        // One pair failing (e.g. a disc fetch error) must not abort the whole run.
        if (!ctrl.signal.aborted) {
          console.warn(`matrix: link ${tx.id}->${rx.id} failed; skipped`, err);
        }
      }
      if (ctrl.signal.aborted) {
        return;
      }
      done++;
      if (link) {
        run.onLink?.(link, done, total);
      }
    });
    // Cancelled mid-run: reject so the store's superseded run is dropped (the new run owns the state).
    if (ctrl.signal.aborted) {
      throw new DOMException('cancelled', 'AbortError');
    }
  })();
  const cancel = (): void => {
    ctrl.abort();
  };
  return { promise, cancel };
}

// Run a single point-to-point profile. Unlike the matrix/coverage paths, the profile reads terrain
// only along the TX->RX line, so it fetches just the CORRIDOR of tiles that line crosses (at the
// source's finest zoom — a long link stays detailed instead of coarsening a whole square) and samples
// the line here on the main thread; only the resulting ProfileSample crosses to the worker for ITM.
export function runProfile(run: ProfileRun): { promise: Promise<ProfileResult>; cancel: () => void } {
  const reqId = ++reqCounter;
  // Aborts the corridor fetch when the run is superseded (e.g. a node was dragged again), so it stops
  // fetching mid-flight rather than running every tile to completion.
  const ctrl = new AbortController();
  const promise = (async (): Promise<ProfileResult> => {
    const corridor = await getCorridor(
      {
        urlTemplate: run.source.urlTemplate, overlays: run.source.overlays, maxzoom: run.source.maxzoom,
        txLon: run.tx.lon, txLat: run.tx.lat, rxLon: run.rx.lon, rxLat: run.rx.lat,
      },
      run.onHeightmapProgress ? (loaded, total) => run.onHeightmapProgress!(loaded, total) : undefined,
      ctrl.signal,
    );
    const sample = sampleProfileCorridor(corridor, run.tx.lon, run.tx.lat, run.rx.lon, run.rx.lat, run.quality ?? {});
    return new Promise<ProfileResult>((resolve, reject) => {
      profileHandlers.set(reqId, { resolve, reject });
      // Transfer the heights buffer (the worker rebuilds the Float64Array over it); terrain rides along.
      getWorker().postMessage(
        {
          type: 'profile-sample', reqId,
          sample: {
            heightsBuffer: sample.heights.buffer,
            spacingM: sample.spacingM, distanceM: sample.distanceM, terrain: sample.terrain,
          },
          tx: run.tx, rx: run.rx, shared: run.shared, sensitivity: run.sensitivity,
        },
        [sample.heights.buffer],
      );
    });
  })();
  const cancel = (): void => {
    ctrl.abort(); // stop the corridor fetch if it's still in flight
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
    // Concentric LOD stack (z-max near the TX, coarser outward; see getLodHeightmap) instead of one
    // map-zoom square. mapZoom is intentionally dropped here — coverage terrain detail is no longer
    // tied to the map's current zoom, so a zoomed-out map no longer flattens the sweep's terrain.
    const lod = await getLodHeightmap(
      { urlTemplate: run.source.urlTemplate, overlays: run.source.overlays, maxzoom: run.source.maxzoom, lon: run.tx.lon, lat: run.tx.lat, radiusM: run.radiusM },
      run.onHeightmapProgress ? (loaded, total) => run.onHeightmapProgress!(loaded, total) : undefined,
    );
    return new Promise<CoverageGrid>((resolve, reject) => {
      coverageHandlers.set(reqId, { onProgress: run.onProgress, resolve, reject });
      getWorker().postMessage({
        type: 'coverage', reqId, lod: wireLod(lod),
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
      { urlTemplate: run.source.urlTemplate, overlays: run.source.overlays, maxzoom: run.source.maxzoom, lon, lat, radiusM, mapZoom: run.source.mapZoom },
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
