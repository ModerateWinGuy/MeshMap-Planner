// Shared shapes for the client-side coverage + relay computation, so the two modules (coverage.ts,
// relay.ts) can be developed against a stable contract. Coverage produces a per-cell received-power
// grid; relay intersects two such grids.

import type { ProfileOptions } from './profile.ts';

// A transmitter for a coverage pass (tx_power already watts->dBm, as the store payloads provide it).
export interface CoverageNode {
  lat: number;
  lon: number;
  height: number; // antenna AGL, m
  tx_power: number; // dBm
  tx_gain: number; // dB
  frequency_mhz: number;
  system_loss: number; // dB
}

// The output grid is sampled over an explicit lon/lat bbox so two relay passes can share alignment
// (their cells coincide). Row 0 is the NORTH edge; column 0 the WEST edge.
export interface CoverageOptions {
  west: number;
  south: number;
  east: number;
  north: number;
  width: number; // OUTPUT raster columns (the rasterization target — cheap, decoupled from ITM cost)
  height: number; // OUTPUT raster rows
  rxHeightM: number; // receiver AGL used at each tested cell
  quality?: ProfileOptions; // profile sampling fidelity (per-path); unused by the radial sweep, kept for relay/back-compat
  // Radial-sweep params (optional so relay, which calls computeCoverage without them, defaults sanely).
  radiusM?: number; // disc radius from the TX (centre of the bbox). Default: half the bbox lat span in metres.
  azimuths?: number; // number of rays. Default 720.
  rangeSteps?: number; // samples per ray from the TX to radiusM. Default 256.
}

// Per-cell received power (dBm), row-major, north row first. NaN marks a cell with no usable result.
// dbm = (tx_power + tx_gain - system_loss) - path_loss  (receiver gain NOT included, matching the
// server's coverage_dbm_points; relay adds the relay rx gain when forming margins).
export interface CoverageGrid {
  dbm: Float32Array; // length width*height
  width: number;
  height: number;
  west: number;
  south: number;
  east: number;
  north: number;
}
