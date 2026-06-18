// Build the terrain profile an ITM point-to-point run consumes, sampled from the SAME Terrarium
// heightmap the map draws (see src/viewshed/heightmap.ts). The profile is the bridge between the
// browser's terrain and SPLAT's elev[] convention:
//
//   - samples run along the great circle TX->RX at UNIFORM ground spacing (ITM requires even spacing)
//   - heights are RAW ground elevation ASL — ITM applies earth curvature itself, so unlike the
//     viewshed we do NOT pre-sag the terrain here
//
// Sampling resolution defaults to one sample per heightmap pixel, so the profile fidelity tracks
// whatever terrain (DEM/DSM/SRTM, at the map's zoom) is currently displayed.

import {
  type Heightmap, type CorridorTiles,
  lngLatToMosaicPixel, mosaicMetresPerPixel,
  sampleCorridorHeightAt, corridorMetresPerPixel,
} from '../viewshed/heightmap.ts';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_M = 6371000.0; // matches the curvature constant used across the sim

export interface ProfileSample {
  heights: Float64Array; // ground elevation ASL (m), TX->RX, uniform spacing
  spacingM: number; // distance between consecutive samples (m)
  distanceM: number; // great-circle TX->RX distance (m)
  terrain: Array<[number, number]>; // [distance_km, elevation_m] for the profile chart / Fresnel calc
}

export interface ProfileOptions {
  // Desired ground spacing between samples (m). Defaults to the heightmap's own pixel size, so the
  // profile is as detailed as the displayed terrain. Larger = coarser/faster (a quality knob).
  targetSpacingM?: number;
  // Clamp on sample count: ITM needs a handful; the cap bounds per-path cost in the coverage loop.
  minPoints?: number;
  maxPoints?: number;
}

// Great-circle distance (m) between two lon/lat points.
export function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = lat1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD;
  const dφ = (lat2 - lat1) * DEG2RAD;
  const dλ = (lon2 - lon1) * DEG2RAD;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Point a fraction f (0..1) of the way along the great circle from (lon1,lat1) to (lon2,lat2).
// Linear lon/lat interpolation drifts off the true path on long links; this stays on the geodesic.
export function interpGreatCircle(
  lon1: number, lat1: number, lon2: number, lat2: number, f: number,
): [number, number] {
  const φ1 = lat1 * DEG2RAD, λ1 = lon1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD, λ2 = lon2 * DEG2RAD;
  const dφ = φ2 - φ1, dλ = λ2 - λ1;
  const hav = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const δ = 2 * Math.asin(Math.min(1, Math.sqrt(hav))); // angular distance
  if (δ < 1e-9) {
    return [lon1, lat1];
  }
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  const φ = Math.atan2(z, Math.hypot(x, y));
  const λ = Math.atan2(y, x);
  return [λ * RAD2DEG, φ * RAD2DEG];
}

// Decode one Terrarium texel to metres: h = (R*256 + G + B/256) - 32768. The sea sentinel
// (R128,G0,B0) used for failed tiles decodes to exactly 0 m.
function decodeTexel(hm: Heightmap, px: number, py: number): number {
  const x = px < 0 ? 0 : px >= hm.width ? hm.width - 1 : px;
  const y = py < 0 ? 0 : py >= hm.height ? hm.height - 1 : py;
  const i = (y * hm.width + x) * 4;
  return hm.data[i] * 256 + hm.data[i + 1] + hm.data[i + 2] / 256 - 32768;
}

// Bilinearly sample the heightmap (m ASL) at a lon/lat. Bilinear (vs the viewshed's nearest) gives
// a smoother profile, which suits ITM's sensitivity to terrain spikes.
export function sampleHeightAt(hm: Heightmap, lon: number, lat: number): number {
  const [mx, my] = lngLatToMosaicPixel(hm, lon, lat);
  const x0 = Math.floor(mx - 0.5);
  const y0 = Math.floor(my - 0.5);
  const fx = mx - 0.5 - x0;
  const fy = my - 0.5 - y0;
  const h00 = decodeTexel(hm, x0, y0);
  const h10 = decodeTexel(hm, x0 + 1, y0);
  const h01 = decodeTexel(hm, x0, y0 + 1);
  const h11 = decodeTexel(hm, x0 + 1, y0 + 1);
  const top = h00 + (h10 - h00) * fx;
  const bot = h01 + (h11 - h01) * fx;
  return top + (bot - top) * fy;
}

// Walk the TX->RX great circle at uniform spacing, reading each point's ground height from `height`.
// Shared by the square (sampleProfile) and corridor (sampleProfileCorridor) samplers — they differ
// only in the height source and the default spacing, so the loop lives here once.
function buildProfile(
  txLon: number, txLat: number,
  rxLon: number, rxLat: number,
  defaultSpacingM: number,
  opts: ProfileOptions,
  height: (lon: number, lat: number) => number,
): ProfileSample {
  const distanceM = haversineM(txLon, txLat, rxLon, rxLat);
  const spacing = opts.targetSpacingM ?? defaultSpacingM;
  const minPoints = opts.minPoints ?? 16;
  const maxPoints = opts.maxPoints ?? 2048;

  let n = Math.round(distanceM / Math.max(spacing, 1)) + 1;
  n = Math.max(minPoints, Math.min(maxPoints, n));

  const heights = new Float64Array(n);
  const terrain: Array<[number, number]> = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1);
    const [lon, lat] = interpGreatCircle(txLon, txLat, rxLon, rxLat, f);
    const h = height(lon, lat);
    heights[i] = h;
    terrain[i] = [(f * distanceM) / 1000, Math.round(h)];
  }

  return { heights, spacingM: distanceM / Math.max(n - 1, 1), distanceM, terrain };
}

// Sample the TX->RX terrain profile from an already-fetched heightmap. Pure (no I/O): the caller
// fetches the covering mosaic (via getHeightmap) so this stays trivially testable.
export function sampleProfile(
  hm: Heightmap,
  txLon: number, txLat: number,
  rxLon: number, rxLat: number,
  opts: ProfileOptions = {},
): ProfileSample {
  const midLat = (txLat + rxLat) / 2;
  return buildProfile(
    txLon, txLat, rxLon, rxLat,
    mosaicMetresPerPixel(hm, midLat), opts,
    (lon, lat) => sampleHeightAt(hm, lon, lat),
  );
}

// Sample the TX->RX terrain profile from a corridor fetch (the long-link path: full-zoom tiles along
// only the line; see getCorridor). Same loop and ProfileSample as sampleProfile — only the height
// source and the default spacing (the corridor zoom's metres-per-pixel) differ — so it honours the
// same ProfileOptions density knob and stays byte-for-byte equal to the square for short links.
export function sampleProfileCorridor(
  c: CorridorTiles,
  txLon: number, txLat: number,
  rxLon: number, rxLat: number,
  opts: ProfileOptions = {},
): ProfileSample {
  const midLat = (txLat + rxLat) / 2;
  return buildProfile(
    txLon, txLat, rxLon, rxLat,
    corridorMetresPerPixel(c, midLat), opts,
    (lon, lat) => sampleCorridorHeightAt(c, lon, lat),
  );
}
