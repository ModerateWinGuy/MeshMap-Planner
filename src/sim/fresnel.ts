// Geometric first-Fresnel-zone clearance — a port of Splat._fresnel_clearance_pct
// (app/services/splat.py). This is the SAME figure the profile chart draws and the link matrix
// shows, kept identical to the server so the two never disagree.
//
// It is a geometric indicator only; link viability comes from the ITM margin, not this.

// Effective-earth-radius (4/3) model for the line-of-sight curvature bulge. Mirrors the constants
// shared by the 3D links and the viewshed (src/viewshed/gpu.ts INV_KR2) and the Python service.
const EARTH_RADIUS_M = 6371000.0;
const K_FACTOR = 4.0 / 3.0;

// Worst-point first-Fresnel-zone clearance along the path, as a percentage of the Fresnel radius:
// (LOS - terrain) / F1, minimised over the path.
//
//   100% = terrain just touches the edge of the first Fresnel zone (fully clear)
//    60% = the usual rule-of-thumb boundary
//     0% = terrain grazes the line of sight
//   < 0% = the LOS is blocked by terrain
//
// The line of sight runs antenna-top to antenna-top (ground + AGL) and is sagged by the earth's
// curvature bulge so long paths read correctly. `terrain` is [distance_km, ground_elevation_m]
// samples TX->RX (distance 0 = transmitter). Returns null if terrain is unavailable.
export function fresnelClearancePct(
  terrain: Array<[number, number]>,
  txHeightM: number,
  rxHeightM: number,
  freqMhz: number,
  distanceKm: number,
): number | null {
  if (!terrain || terrain.length < 2 || freqMhz <= 0) {
    return null;
  }

  const distanceM = Math.max(distanceKm * 1000.0, 1.0);
  const wavelength = 299.792458 / freqMhz; // metres
  const topA = terrain[0][1] + txHeightM; // antenna tops above sea level (LOS endpoints)
  const topB = terrain[terrain.length - 1][1] + rxHeightM;

  let minClear: number | null = null;
  for (const [distKm, ground] of terrain) {
    const d1 = Math.min(Math.max(distKm * 1000.0, 0.0), distanceM);
    const frac = d1 / distanceM;
    const bulge = (d1 * (distanceM - d1)) / (2.0 * K_FACTOR * EARTH_RADIUS_M);
    const los = topA + (topB - topA) * frac - bulge;
    const f1 = Math.sqrt(Math.max((wavelength * d1 * (distanceM - d1)) / distanceM, 0.0));
    // Skip the path ends where F1 collapses to 0 and the ratio is meaningless.
    if (f1 > 0.5) {
      const clearance = (los - ground) / f1;
      if (minClear === null || clearance < minClear) {
        minClear = clearance;
      }
    }
  }

  if (minClear === null) {
    return null;
  }
  return Math.round(Math.min(minClear * 100.0, 100.0) * 10) / 10;
}
