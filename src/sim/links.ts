// Point-to-point link + profile computation, driven by the WASM ITM core and the map's own
// heightmap. Pure given an ITM module and a heightmap (no DOM / no I/O), so it runs unchanged inside
// the sim Web Worker and is testable.
//
//   - rx_power = (tx_power_dBm + tx_gain - system_loss) - path_loss   (SPLAT's ERP-basis received power)
//   - margin   = (rx_power + rx_gain) - sensitivity ; viable = margin >= 0
//   - frequency / power / gains / system_loss are the TX node's; position/height/rx_gain the RX node's
//   - clutter_height is added to interior terrain points (not the antenna sites), as SPLAT's -gc does

import type { Heightmap } from '../viewshed/heightmap.ts';
import type { LinkResult, ProfileResult } from '../types.ts';
import { type ItmModule, itmP2P } from './itm/index.ts';
import { sampleProfile, sampleHeightAt, type ProfileOptions } from './profile.ts';
import { fresnelClearancePct } from './fresnel.ts';
import { climateCode, polarizationCode } from './itmParams.ts';

// A node as the matrix/profile payloads already shape it (tx_power already watts->dBm in the store).
export interface SimNode {
  id: string;
  lat: number;
  lon: number;
  height: number; // antenna AGL, m
  tx_power: number; // dBm
  tx_gain: number; // dB
  rx_gain: number; // dB
  frequency_mhz: number;
  system_loss: number; // dB
}

// Shared environment / model params (the matrix/profile "shared" block).
export interface SimShared {
  clutter_height: number;
  ground_dielectric: number;
  ground_conductivity: number;
  atmosphere_bending: number;
  radio_climate: string;
  polarization: string;
  situation_fraction: number; // %
  time_fraction: number; // %
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
// ITM conf/rel must sit in (0,1); qerfi blows up at the ends. Clamp like a fraction of a percent in.
const clampFrac = (pct: number): number => Math.min(0.999, Math.max(0.001, pct / 100));

// Distance to the geometric LOS horizon (k=4/3 effective Earth): 4.1225·(√h_a+√h_b) km on heights
// above sea level, used to pre-filter impossible matrix pairs.
const RADIO_HORIZON_KM_PER_SQRT_M = Math.sqrt(2 * (4 / 3) * 6_371_000) / 1000; // ~4.1225
export function radioHorizonKm(hAmslA: number, hAmslB: number): number {
  return RADIO_HORIZON_KM_PER_SQRT_M * (Math.sqrt(Math.max(0, hAmslA)) + Math.sqrt(Math.max(0, hAmslB)));
}

// Ground elevation (m ASL) at a node, from the active heightmap — used for the horizon pre-filter.
export function groundElevationM(hm: Heightmap, node: SimNode): number {
  return sampleHeightAt(hm, node.lon, node.lat);
}

// Core ITM evaluation shared by link and profile. Returns the raw ITM result plus the derived
// link-budget figures, given a resolved sensitivity (dBm).
function evaluate(
  mod: ItmModule,
  hm: Heightmap,
  tx: SimNode,
  rx: SimNode,
  shared: SimShared,
  sensitivity: number,
  quality: ProfileOptions,
) {
  const profile = sampleProfile(hm, tx.lon, tx.lat, rx.lon, rx.lat, quality);

  // Apply uniform ground clutter to interior points only (the antennas sit on bare ground).
  const heights = profile.heights;
  if (shared.clutter_height > 0) {
    for (let i = 1; i < heights.length - 1; i++) {
      heights[i] += shared.clutter_height;
    }
  }

  const itm = itmP2P(mod, {
    heights,
    spacingM: profile.spacingM,
    txHeightM: tx.height,
    rxHeightM: rx.height,
    epsDielect: shared.ground_dielectric,
    sgmConductivity: shared.ground_conductivity,
    ensSurfref: shared.atmosphere_bending,
    freqMhz: tx.frequency_mhz,
    radioClimate: climateCode(shared.radio_climate),
    pol: polarizationCode(shared.polarization),
    conf: clampFrac(shared.situation_fraction),
    rel: clampFrac(shared.time_fraction),
  });

  const distanceKm = profile.distanceM / 1000;
  const erpDbm = tx.tx_power + tx.tx_gain - tx.system_loss;
  const rxPower = erpDbm - itm.pathLossDb;
  const margin = rxPower + rx.rx_gain - sensitivity;
  const fresnel = fresnelClearancePct(profile.terrain, tx.height, rx.height, tx.frequency_mhz, distanceKm);

  return { profile, itm, distanceKm, rxPower, margin, fresnel };
}

// One matrix link (LinkResult shape). Never throws for a single pair: a failure is recorded as
// error + viable:false so one bad pair can't abort the matrix.
export function computeLink(
  mod: ItmModule,
  hm: Heightmap,
  tx: SimNode,
  rx: SimNode,
  shared: SimShared,
  sensitivity: number,
  quality: ProfileOptions = {},
): LinkResult {
  const link: LinkResult = {
    a: tx.id, b: rx.id,
    distance_km: null, path_loss_db: null, rx_power_dbm: null,
    fresnel_pct: null, margin_db: null, viable: false, error: null,
  };
  try {
    const e = evaluate(mod, hm, tx, rx, shared, sensitivity, quality);
    link.distance_km = round3(e.distanceKm);
    link.path_loss_db = round2(e.itm.pathLossDb);
    link.rx_power_dbm = round2(e.rxPower);
    link.fresnel_pct = e.fresnel;
    link.margin_db = round2(e.margin);
    link.viable = e.margin >= 0;
  } catch (err) {
    link.error = err instanceof Error ? err.message : String(err);
  }
  return link;
}

// Single point-to-point profile (ProfileResult shape) for the bottom strip chart.
export function computeProfile(
  mod: ItmModule,
  hm: Heightmap,
  tx: SimNode,
  rx: SimNode,
  shared: SimShared,
  sensitivity: number,
  quality: ProfileOptions = {},
): ProfileResult {
  const e = evaluate(mod, hm, tx, rx, shared, sensitivity, quality);
  const rxSignal = e.rxPower + rx.rx_gain;
  return {
    distance_km: round3(e.distanceKm),
    path_loss_db: round2(e.itm.pathLossDb),
    free_space_db: round2(e.itm.freeSpaceDb),
    rx_power_dbm: round2(e.rxPower),
    fresnel_pct: e.fresnel,
    tx_eirp_dbm: round2(tx.tx_power + tx.tx_gain),
    rx_signal_dbm: round2(rxSignal),
    margin_db: round2(e.margin),
    sensitivity_dbm: round2(sensitivity),
    viable: e.margin >= 0,
    profile: { terrain: e.profile.terrain },
  };
}
