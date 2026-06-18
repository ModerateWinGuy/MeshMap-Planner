// RF coverage as a RADIAL SWEEP from the TX, then rasterized into the output grid.
//
// Why radial rather than a uniform per-cell grid: a uniform 8 m grid over a 30 km radius is ~56M ITM
// calls (infeasible). A radial sweep fires `azimuths` rays out to `radiusM` with `rangeSteps` samples
// each, sampling every ray's terrain ONCE and reusing it as a growing prefix profile per range step.
// That concentrates compute near the TX (sharp close-in coverage) and decouples the displayed overlay
// resolution (width×height, a cheap rasterization target) from the ITM budget (≈ az × rangeSteps²/2).
//
// Each ray IS the terrain profile, so unlike a per-cell grid this samples no per-path profile and
// ignores opts.quality. Otherwise the ITM parameter assembly mirrors links.ts evaluate() exactly.
// Pure given an ITM module + heightmap (no DOM / no I/O), so it runs unchanged inside the sim Web Worker.
//
//   - dbm = (tx_power + tx_gain - system_loss) - path_loss   (SPLAT's ERP-basis received power)
//   - receiver gain is NOT included here; relay forms margins by adding the relay rx gain per cell
//   - clutter_height is added to interior terrain points (not the antenna sites), as SPLAT's -gc does

import type { Heightmap, LodHeightmap } from '../viewshed/heightmap.ts';
import { type ItmModule, itmP2P } from './itm/index.ts';
import { sampleLodHeightAt } from './profile.ts';
import { climateCode, polarizationCode } from './itmParams.ts';
import type { SimShared } from './links.ts';
import type { CoverageNode, CoverageOptions, CoverageGrid } from './coverageTypes.ts';

// ITM conf/rel must sit in (0,1); qerfi blows up at the ends. Clamp like links.ts clampFrac does.
const clampFrac = (pct: number): number => Math.min(0.999, Math.max(0.001, pct / 100));

// Below this TX->cell distance ITM (Longley-Rice) is unreliable: at very short range it can wildly
// over-attenuate (it's a beyond-horizon/terrain model, not a near-field one), which made cells right
// around the node read far weaker than reality. Within NEAR_FIELD_M we substitute plain free-space
// path loss, which is the correct close-in behaviour and reads strong as expected.
const NEAR_FIELD_M = 300;

// Free-space path loss (dB) for a distance and frequency. 32.45 is the constant for km + MHz.
const freeSpaceLossDb = (distM: number, freqMhz: number): number => {
  const distKm = Math.max(distM, 1) / 1000; // floor avoids log10(0) at the TX's own cell
  return 32.45 + 20 * Math.log10(freqMhz) + 20 * Math.log10(distKm);
};

// Relay (and any caller still handing in a plain square) is wrapped into a single-level stack so the
// sweep below has one sampling path. A single level covers the whole disc, so the sampler never falls
// to a coarser ring — innerRadiusM only has to exceed every sample's distance, which radiusM does.
function wrapSingle(hm: Heightmap, radiusM: number): LodHeightmap {
  return { levels: [{ hm, innerRadiusM: radiusM }], lon: 0, lat: 0 };
}

export function computeCoverage(
  mod: ItmModule,
  hm: Heightmap | LodHeightmap,
  tx: CoverageNode,
  shared: SimShared,
  opts: CoverageOptions,
  onProgress?: (done: number, total: number) => void,
): CoverageGrid {
  const { width, height } = opts;

  // Radial-sweep params. Defaults keep relay (which omits them) working: radiusM falls back to half
  // the bbox lat span in metres (the disc inscribed in the square bbox).
  const az = opts.azimuths ?? 720;
  const rangeSteps = opts.rangeSteps ?? 256;
  const radiusM = opts.radiusM ?? ((opts.north - opts.south) / 2) * 111320;
  const rangeStepM = radiusM / rangeSteps; // range step k sits at distance (k+1)*rangeStepM

  // Coverage hands in an LOD stack (high zoom near the TX, coarser outward); relay still passes a single
  // square, which we wrap so the per-sample level pick is uniform. distM drives the level selection.
  const lod: LodHeightmap = 'levels' in hm ? hm : wrapSingle(hm, radiusM);

  // ERP basis, computed once: the receiver-gain-free transmit term subtracted by ITM path loss.
  const erpDbm = tx.tx_power + tx.tx_gain - tx.system_loss;
  const radioClimate = climateCode(shared.radio_climate);
  const pol = polarizationCode(shared.polarization);
  const conf = clampFrac(shared.situation_fraction);
  const rel = clampFrac(shared.time_fraction);
  const cosLat = Math.max(0.01, Math.cos((tx.lat * Math.PI) / 180)); // longitude metres/deg floor near poles

  // Polar received-power field, indexed [a*rangeSteps + k]: ray a (bearing 2π·a/az from north,
  // clockwise), range step k (distance (k+1)*rangeStepM). NaN marks an ITM failure.
  const polar = new Float32Array(az * rangeSteps);
  const total = az * rangeSteps;

  // Reused per ray: terrain height ASL at the TX (index 0) and at each range step (1..rangeSteps).
  // The prefix rayH[0..k+1] (k+2 points, spacing rangeStepM) is the TX->cell profile for step k.
  const rayH = new Float64Array(rangeSteps + 1);

  for (let a = 0; a < az; a++) {
    const theta = (2 * Math.PI * a) / az; // bearing from NORTH, clockwise
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // Sample the ray's terrain once. Local equirectangular offset (coverage radius ≤100 km, so the
    // great circle isn't worth its trig here): northing = d·cosθ, easting = d·sinθ.
    rayH[0] = sampleLodHeightAt(lod, tx.lon, tx.lat, 0); // TX ground (finest level)
    for (let s = 1; s <= rangeSteps; s++) {
      const d = s * rangeStepM;
      const lat = tx.lat + (d * cosT) / 111320;
      const lon = tx.lon + (d * sinT) / (111320 * cosLat);
      rayH[s] = sampleLodHeightAt(lod, lon, lat, d); // coarsens with distance, matching the sweep
    }

    // Uniform ground clutter on interior ray points only (the antennas sit on bare ground), matching
    // links.ts evaluate() and SPLAT's -gc. rayH[0] stays the TX site; each prefix's rx endpoint also
    // getting clutter is a negligible approximation accepted to keep one shared height array per ray.
    if (shared.clutter_height > 0) {
      for (let s = 1; s < rangeSteps; s++) {
        rayH[s] += shared.clutter_height;
      }
    }

    for (let k = 0; k < rangeSteps; k++) {
      const distM = (k + 1) * rangeStepM;
      const idx = a * rangeSteps + k;

      // Near-field: ITM (Longley-Rice, a beyond-horizon/terrain model) over-attenuates at short
      // range, so substitute plain free-space loss close in — the correct near-site behaviour. This
      // also covers k=0 (the cell nearest the TX), which would otherwise read far too weak.
      if (distM < NEAR_FIELD_M) {
        polar[idx] = erpDbm - freeSpaceLossDb(distM, tx.frequency_mhz);
        continue;
      }

      try {
        // Prefix profile rayH[0..k+1] = k+2 points. Pass a subarray VIEW (itmP2P reads .length and
        // indexes, copying into its own heap) so no per-step allocation/copy happens here.
        const itm = itmP2P(mod, {
          heights: rayH.subarray(0, k + 2),
          spacingM: rangeStepM,
          txHeightM: tx.height,
          rxHeightM: opts.rxHeightM,
          epsDielect: shared.ground_dielectric,
          sgmConductivity: shared.ground_conductivity,
          ensSurfref: shared.atmosphere_bending,
          freqMhz: tx.frequency_mhz,
          radioClimate,
          pol,
          conf,
          rel,
        });
        polar[idx] = erpDbm - itm.pathLossDb;
      } catch {
        // A single failed path must not abort the sweep: mark the sample unusable and move on.
        polar[idx] = NaN;
      }
    }
    // Emit once per completed ray — fine-grained enough to drive a progress bar, cheap enough to not
    // throttle the hot loop.
    onProgress?.((a + 1) * rangeSteps, total);
  }

  // Rasterize the polar field into the output grid. Row 0 is the NORTH edge; each cell is sampled at
  // its centre (+0.5) so the overlay drapes correctly. Cells beyond the disc stay NaN (transparent
  // corners).
  const dbm = new Float32Array(width * height).fill(NaN);
  for (let r = 0; r < height; r++) {
    const lat = opts.north - ((r + 0.5) / height) * (opts.north - opts.south);
    const dN = (lat - tx.lat) * 111320; // northing from TX, m
    const rowBase = r * width;
    for (let c = 0; c < width; c++) {
      const lon = opts.west + ((c + 0.5) / width) * (opts.east - opts.west);
      const dE = (lon - tx.lon) * 111320 * cosLat; // easting from TX, m
      const dist = Math.hypot(dN, dE);
      if (dist > radiusM) {
        continue; // outside the swept disc — leave NaN
      }
      const theta = Math.atan2(dE, dN); // bearing from north, clockwise (matches the sweep)
      // Nearest ray, wrapped into [0, az): the +az before the final %az fixes negative atan2 angles.
      const a = ((Math.round((theta / (2 * Math.PI)) * az) % az) + az) % az;
      // Nearest range step; -1 because step k is at (k+1)*rangeStepM. Clamp into [0, rangeSteps-1].
      const k = Math.min(rangeSteps - 1, Math.max(0, Math.round(dist / rangeStepM) - 1));
      dbm[rowBase + c] = polar[a * rangeSteps + k];
    }
  }

  return {
    dbm,
    width,
    height,
    west: opts.west,
    south: opts.south,
    east: opts.east,
    north: opts.north,
  };
}
