// Backs the 'heightmap' basemap. MapLibre's color-relief layer does the height-to-colour lookup on
// the GPU; all this module does is decide what range to spread the colours over.

import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  DEM_MAXZOOM,
  MAPTERHORN_TEMPLATE,
  TILE,
  composeTerrariumTileRGBACached,
  decodeTerrarium,
  type OverlaySpec,
} from './demTiles.ts';
import { colormap } from '../sim/colormap.ts';

// Covers a typical desktop map area without coarsening. Coarsening costs resolution, not accuracy.
const MAX_SCAN_TILES = 40;
const SCAN_STRIDE = 4;
const RAMP_STOPS = 16;

// Web Mercator can't represent the poles; clamp before the tan() below.
function clampLat(lat: number): number {
  return lat < -85.05 ? -85.05 : lat > 85.05 ? 85.05 : lat;
}

// Fractional, so the scan can clip to the view edge rather than the enclosing tile boundary.
function tileXFrac(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

function tileYFrac(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

// A `color-relief-color` value running a colormap from minM to maxM.
export function reliefRampExpression(gradientName: string, minM: number, maxM: number): unknown[] {
  const fn = colormap(gradientName);
  // interpolate rejects non-ascending stops, so flat terrain gets a 1 m span (and unrounded stops).
  const hi = maxM - minM < 1 ? minM + 1 : maxM;
  const expr: unknown[] = ['interpolate', ['linear'], ['elevation']];
  for (let i = 0; i <= RAMP_STOPS; i++) {
    const t = i / RAMP_STOPS;
    const [r, g, b] = fn(t);
    expr.push(minM + (hi - minM) * t, `rgb(${r},${g},${b})`);
  }
  return expr;
}

export interface ScanJob {
  x: number;
  y: number;
  // Half-open pixel range within the tile: [lx0, lx1) x [ly0, ly1).
  lx0: number;
  lx1: number;
  ly0: number;
  ly1: number;
}

// Which tile pixels cover a lat/lon box, each tile clipped to it. Exported as pure geometry so the
// clipping can be checked without a network or a GL context (see reliefRange.check.mjs).
export function scanJobs(
  west: number,
  east: number,
  north: number,
  south: number,
  startZoom: number,
): { z: number; jobs: ScanJob[] } {
  for (let z = startZoom; ; z--) {
    const n = 2 ** z;
    // x stays unwrapped so a view crossing the antimeridian still yields an ascending range.
    const fx0 = tileXFrac(west, z);
    const fx1 = tileXFrac(east, z);
    const fy0 = Math.max(0, tileYFrac(clampLat(north), z)); // north edge -> smaller y
    const fy1 = Math.min(n, tileYFrac(clampLat(south), z));
    const x0 = Math.floor(fx0);
    const y0 = Math.floor(fy0);
    const nx = Math.min(n, Math.floor(fx1) - x0 + 1);
    const ny = Math.min(n - 1, Math.floor(fy1)) - y0 + 1;
    if (nx * ny > MAX_SCAN_TILES && z > 0) {
      continue;
    }
    const pxWest = fx0 * TILE;
    const pxEast = fx1 * TILE;
    const pyNorth = fy0 * TILE;
    const pySouth = fy1 * TILE;
    const jobs: ScanJob[] = [];
    for (let i = 0; i < nx; i++) {
      const ox = (x0 + i) * TILE;
      const lx0 = Math.max(0, Math.ceil(pxWest - ox));
      const lx1 = Math.min(TILE, Math.ceil(pxEast - ox));
      if (lx1 <= lx0) {
        continue;
      }
      const x = (((x0 + i) % n) + n) % n;
      for (let j = 0; j < ny; j++) {
        const y = y0 + j;
        const oy = y * TILE;
        const ly0 = Math.max(0, Math.ceil(pyNorth - oy));
        const ly1 = Math.min(TILE, Math.ceil(pySouth - oy));
        if (ly1 > ly0) {
          jobs.push({ x, y, lx0, lx1, ly0, ly1 });
        }
      }
    }
    return { z, jobs };
  }
}

// Metres, across the map's current view.
//
// Sampled per clipped pixel rather than per whole tile: the covering tile block overhangs the screen
// by up to ~20 km at z11, enough for an off-screen summit to steal the top of the gradient.
//
// Goes through the map's own baseline + overlays, so it shares the composited-tile cache.
//
// ponytail: clipped to the lat/lon box, so bearing/pitch still admit some corner terrain. Upgrade
// path: project the view corners once, test samples against that quad.
//
// ponytail: CPU decode of <=40 tiles per view change, cold when no DEM provider is enabled. Upgrade
// path: MapLibre's already-decoded tile.dem, at the cost of private API.
export async function visibleElevationRange(
  map: MapLibreMap,
  overlays: OverlaySpec[],
  signal?: AbortSignal,
): Promise<{ min: number; max: number } | null> {
  const b = map.getBounds();
  const { z, jobs } = scanJobs(
    b.getWest(),
    b.getEast(),
    b.getNorth(),
    b.getSouth(),
    Math.max(0, Math.min(DEM_MAXZOOM, Math.round(map.getZoom()))),
  );

  let min = Infinity;
  let max = -Infinity;
  await Promise.all(
    jobs.map(async (job) => {
      // Shared by reference and read-only by contract — sample only.
      const rgba = await composeTerrariumTileRGBACached(z, job.x, job.y, MAPTERHORN_TEMPLATE, overlays, signal);
      if (!rgba) {
        return;
      }
      for (let py = job.ly0; py < job.ly1; py += SCAN_STRIDE) {
        for (let px = job.lx0; px < job.lx1; px += SCAN_STRIDE) {
          const i = (py * TILE + px) * 4;
          const h = decodeTerrarium(rgba[i], rgba[i + 1], rgba[i + 2]);
          if (h < min) {
            min = h;
          }
          if (h > max) {
            max = h;
          }
        }
      }
    }),
  );

  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}
