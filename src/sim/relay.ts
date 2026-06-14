// Client-side port of the relay-siting logic in app/services/splat.py (`relay_overlap` and its
// helpers). The server bins two radial SPLAT! coverage passes onto a shared coarse grid; here we
// instead receive two already-aligned coverage grids (same width/height/bbox, so cell (r,c) is the
// same ground location in both) and intersect them directly. The algorithm — per-cell margins,
// 4-connected islands, band colouring, and point ranking — mirrors the reference faithfully.

import type { CoverageGrid } from './coverageTypes.ts';
import type {
  RelayResult,
  RelayZoneProps,
  RelayPointProps,
  FeatureCollection,
} from '../types.ts';

export interface RelayParams {
  sensitivity_dbm: number;
  relay_rx_gain: number; // dB, added to each cell's dbm to form the margin
  band_edges_db: number[]; // ascending margin band edges (e.g. [0, 5, 10, 20])
  top_n: number; // number of suggested relay points
  node_a_id: string;
  node_b_id: string;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

// Mean Earth metres per degree at the equator for the km area approximation (matches splat.py).
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

// Background marker shared by the component labels and the per-cell band grid.
const BACKGROUND = -1;

export function relayOverlap(
  gridA: CoverageGrid,
  gridB: CoverageGrid,
  params: RelayParams,
): RelayResult {
  if (
    gridA.width !== gridB.width ||
    gridA.height !== gridB.height ||
    gridA.west !== gridB.west ||
    gridA.south !== gridB.south ||
    gridA.east !== gridB.east ||
    gridA.north !== gridB.north
  ) {
    throw new Error('relayOverlap: gridA and gridB must be aligned (same width/height/bbox).');
  }

  const { sensitivity_dbm, relay_rx_gain, band_edges_db, top_n, node_a_id, node_b_id } = params;
  const { width, height, west, south, east, north } = gridA;
  const cellDegLon = (east - west) / width;
  const cellDegLat = (north - south) / height;

  // Per-cell min margin over the whole grid; NaN where the cell is not a zone cell. Margins A/B are
  // kept for the ranked points' properties.
  const n = width * height;
  const minMargin = new Float32Array(n);
  const marginAGrid = new Float32Array(n);
  const marginBGrid = new Float32Array(n);
  const isZone = new Uint8Array(n);
  let zoneCount = 0;
  for (let i = 0; i < n; i++) {
    const a = gridA.dbm[i];
    const b = gridB.dbm[i];
    if (Number.isNaN(a) || Number.isNaN(b)) {
      minMargin[i] = NaN;
      continue;
    }
    const ma = a + relay_rx_gain - sensitivity_dbm;
    const mb = b + relay_rx_gain - sensitivity_dbm;
    if (ma >= 0 && mb >= 0) {
      isZone[i] = 1;
      marginAGrid[i] = ma;
      marginBGrid[i] = mb;
      minMargin[i] = Math.min(ma, mb);
      zoneCount++;
    } else {
      minMargin[i] = NaN;
    }
  }

  if (zoneCount === 0) {
    return {
      sensitivity_dbm: round2(sensitivity_dbm),
      node_a: node_a_id,
      node_b: node_b_id,
      relay_rx_gain,
      zone: { type: 'FeatureCollection', features: [] },
      points: { type: 'FeatureCollection', features: [] },
      empty: true,
      warning: 'No location receives both A and B above sensitivity.',
    };
  }

  const { labels, count } = labelComponents(isZone, width, height);
  const zoneFeatures = islandPolygons(
    labels,
    count,
    minMargin,
    width,
    height,
    west,
    north,
    cellDegLon,
    cellDegLat,
    band_edges_db,
  );
  const pointFeatures = rankPoints(
    labels,
    count,
    minMargin,
    marginAGrid,
    marginBGrid,
    width,
    height,
    west,
    north,
    cellDegLon,
    cellDegLat,
    top_n,
  );

  return {
    sensitivity_dbm: round2(sensitivity_dbm),
    node_a: node_a_id,
    node_b: node_b_id,
    relay_rx_gain,
    zone: { type: 'FeatureCollection', features: zoneFeatures },
    points: { type: 'FeatureCollection', features: pointFeatures },
    empty: false,
    warning: null,
  };
}

// 4-connected flood fill of a boolean cell mask (dependency-free stack fill, like the Python
// `_label_components`). Returns labels (BACKGROUND for off cells, 0..count-1 for islands) and count.
function labelComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height).fill(BACKGROUND);
  const stack: number[] = []; // packed r*width+c indices
  let count = 0;
  for (let r0 = 0; r0 < height; r0++) {
    for (let c0 = 0; c0 < width; c0++) {
      const start = r0 * width + c0;
      if (!mask[start] || labels[start] !== BACKGROUND) continue;
      labels[start] = count;
      stack.push(start);
      while (stack.length) {
        const idx = stack.pop()!;
        const r = (idx / width) | 0;
        const c = idx - r * width;
        // 4-connected neighbours.
        if (r + 1 < height) maybePush(r + 1, c);
        if (r - 1 >= 0) maybePush(r - 1, c);
        if (c + 1 < width) maybePush(r, c + 1);
        if (c - 1 >= 0) maybePush(r, c - 1);
      }
      count++;
    }
  }
  return { labels, count };

  function maybePush(nr: number, nc: number): void {
    const ni = nr * width + nc;
    if (mask[ni] && labels[ni] === BACKGROUND) {
      labels[ni] = count;
      stack.push(ni);
    }
  }
}

// Band index for a margin: number of ascending edges it meets or exceeds, minus one (clamped >= 0).
function marginBand(peak: number, bandEdges: number[]): number {
  let band = -1;
  for (const e of bandEdges) if (peak >= e) band++;
  return Math.max(band, 0);
}

function bandLabel(band: number, bandEdges: number[]): string {
  if (band >= bandEdges.length - 1) {
    return `>${bandEdges[bandEdges.length - 1].toFixed(0)} dB`;
  }
  return `${bandEdges[band].toFixed(0)}–${bandEdges[band + 1].toFixed(0)} dB`;
}

// One GeoJSON Polygon (or MultiPolygon) Feature per disconnected island, coloured by the island's
// peak-margin band. Geometry is a clean island outline: the cell-set boundary traced as closed
// rings (marching-squares style), one per connected loop, so a non-simply-connected island yields a
// MultiPolygon. Features are sorted by peak margin descending.
function islandPolygons(
  labels: Int32Array,
  count: number,
  minMargin: Float32Array,
  width: number,
  height: number,
  west: number,
  north: number,
  cellDegLon: number,
  cellDegLat: number,
  bandEdges: number[],
): FeatureCollection<RelayZoneProps>['features'] {
  const features: FeatureCollection<RelayZoneProps>['features'] = [];

  for (let islandId = 0; islandId < count; islandId++) {
    let peak = -Infinity;
    let cellSum = 0;
    let rowSum = 0;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (labels[r * width + c] !== islandId) continue;
        const mm = minMargin[r * width + c];
        if (mm > peak) peak = mm;
        cellSum++;
        rowSum += r;
      }
    }
    if (cellSum === 0) continue;

    const band = marginBand(peak, bandEdges);
    // Mean latitude of the island gives an approximate area in km^2 (cell width shrinks with cos lat).
    const meanRow = rowSum / cellSum;
    const meanLat = north - (meanRow + 0.5) * cellDegLat;
    const cellWKm = cellDegLon * KM_PER_DEG_LON_EQUATOR * Math.cos((meanLat * Math.PI) / 180);
    const cellHKm = cellDegLat * KM_PER_DEG_LAT;
    const areaKm2 = cellSum * cellWKm * cellHKm;

    const geometry = traceIslandGeometry(
      labels,
      islandId,
      width,
      height,
      west,
      north,
      cellDegLon,
      cellDegLat,
    );

    features.push({
      type: 'Feature',
      geometry,
      properties: {
        island_id: islandId,
        peak_margin: round2(peak),
        area_km2: round3(areaKm2),
        band,
        label: bandLabel(band, bandEdges),
      },
    });
  }

  features.sort((a, b) => b.properties.peak_margin - a.properties.peak_margin);
  return features;
}

type Ring = Array<[number, number]>;

// Trace the outline of one island's cell-set as closed lon/lat rings. Each island cell contributes
// its four unit edges; edges shared by two island cells cancel, leaving only the outer boundary
// (and any hole boundaries). The surviving edges are stitched head-to-tail into closed loops. A
// single loop yields a Polygon; multiple loops (holes / pinched shapes) yield a MultiPolygon, each
// ring its own polygon so callers needn't resolve outer/hole nesting. Rings are [lon,lat], closed.
function traceIslandGeometry(
  labels: Int32Array,
  islandId: number,
  width: number,
  height: number,
  west: number,
  north: number,
  cellDegLon: number,
  cellDegLat: number,
):
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] } {
  // Boundary edges keyed by their two grid-corner endpoints. Corner (gr,gc) packs as gr*(width+1)+gc
  // where gr in 0..height, gc in 0..width. Each edge is directed so the island interior is on its
  // left, which lets us walk loops by always turning toward the next outgoing edge at a corner.
  const stride = width + 1;
  const edges = new Map<number, number[]>(); // start-corner -> list of end-corners

  const addEdge = (sr: number, sc: number, er: number, ec: number): void => {
    const start = sr * stride + sc;
    const end = er * stride + ec;
    const list = edges.get(start);
    if (list) list.push(end);
    else edges.set(start, [end]);
  };

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (labels[r * width + c] !== islandId) continue;
      // Cell (r,c) occupies grid corners (r,c)=top-left .. (r+1,c+1)=bottom-right. Emit each edge
      // only when the neighbour across it is NOT in this island, directed interior-on-left.
      const top = r > 0 && labels[(r - 1) * width + c] === islandId;
      const bottom = r + 1 < height && labels[(r + 1) * width + c] === islandId;
      const left = c > 0 && labels[r * width + (c - 1)] === islandId;
      const right = c + 1 < width && labels[r * width + (c + 1)] === islandId;
      // Directions chosen so traversal keeps the cell interior on the left (CCW outer boundary):
      // top edge L->R, right edge T->B, bottom edge R->L, left edge B->T.
      if (!top) addEdge(r, c, r, c + 1);
      if (!right) addEdge(r, c + 1, r + 1, c + 1);
      if (!bottom) addEdge(r + 1, c + 1, r + 1, c);
      if (!left) addEdge(r + 1, c, r, c);
    }
  }

  const cornerLonLat = (corner: number): [number, number] => {
    const gr = (corner / stride) | 0;
    const gc = corner - gr * stride;
    return [round6(west + gc * cellDegLon), round6(north - gr * cellDegLat)];
  };

  const rings: Ring[] = [];
  for (const [start, ends] of edges) {
    while (ends.length) {
      // Walk a loop from this unused outgoing edge until we return to the start corner.
      const ring: Ring = [cornerLonLat(start)];
      let current = ends.pop()!;
      while (current !== start) {
        ring.push(cornerLonLat(current));
        const next = edges.get(current);
        // Closed cell-set boundaries are Eulerian, so an outgoing edge always exists until we
        // arrive back at the loop's start corner.
        const nextCorner = next && next.length ? next.pop()! : start;
        current = nextCorner;
      }
      ring.push(cornerLonLat(start)); // close the ring
      rings.push(ring);
    }
  }

  if (rings.length === 1) {
    return { type: 'Polygon', coordinates: [rings[0]] };
  }
  return { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
}

// Suggested relay points: the single best cell of EACH island first (sorted by margin descending),
// then, if fewer islands than top_n, fill remaining slots with the next-best cells globally, keeping
// a minimum separation of 3 cells so fillers don't sit on an already-chosen peak.
function rankPoints(
  labels: Int32Array,
  count: number,
  minMargin: Float32Array,
  marginAGrid: Float32Array,
  marginBGrid: Float32Array,
  width: number,
  height: number,
  west: number,
  north: number,
  cellDegLon: number,
  cellDegLat: number,
  topN: number,
): FeatureCollection<RelayPointProps>['features'] {
  const features: FeatureCollection<RelayPointProps>['features'] = [];
  const chosen: Array<[number, number]> = []; // (row, col)

  const cellCenter = (r: number, c: number): [number, number] => [
    round6(west + (c + 0.5) * cellDegLon),
    round6(north - (r + 0.5) * cellDegLat),
  ];

  const makeFeature = (rank: number, islandId: number, r: number, c: number): void => {
    const i = r * width + c;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: cellCenter(r, c) },
      properties: {
        rank,
        island_id: islandId,
        min_margin: round2(minMargin[i]),
        margin_a: round2(marginAGrid[i]),
        margin_b: round2(marginBGrid[i]),
      },
    });
  };

  // Peak cell of each island.
  const islandPeaks: Array<{ mm: number; islandId: number; r: number; c: number }> = [];
  for (let islandId = 0; islandId < count; islandId++) {
    let best = -Infinity;
    let br = -1;
    let bc = -1;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (labels[r * width + c] !== islandId) continue;
        const mm = minMargin[r * width + c];
        if (mm > best) {
          best = mm;
          br = r;
          bc = c;
        }
      }
    }
    if (br >= 0) islandPeaks.push({ mm: best, islandId, r: br, c: bc });
  }
  islandPeaks.sort((a, b) => b.mm - a.mm);

  for (const { islandId, r, c } of islandPeaks) {
    if (features.length >= topN) break;
    chosen.push([r, c]);
    makeFeature(features.length + 1, islandId, r, c);
  }

  // Fill remaining slots with the next-best cells anywhere, spaced apart.
  if (features.length < topN) {
    const minSep = 3; // cells
    const candidates: number[] = [];
    for (let i = 0; i < minMargin.length; i++) {
      if (!Number.isNaN(minMargin[i])) candidates.push(i);
    }
    candidates.sort((a, b) => minMargin[b] - minMargin[a]);
    for (const i of candidates) {
      if (features.length >= topN) break;
      const r = (i / width) | 0;
      const c = i - r * width;
      const tooClose = chosen.some(
        ([rr, cc]) => Math.abs(r - rr) < minSep && Math.abs(c - cc) < minSep,
      );
      if (tooClose) continue;
      chosen.push([r, c]);
      makeFeature(features.length + 1, labels[i], r, c);
    }
  }

  return features;
}
