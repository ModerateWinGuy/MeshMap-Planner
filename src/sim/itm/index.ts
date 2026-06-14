// Thin TypeScript wrapper around the WASM ITM core (SPLAT's classic Longley-Rice, built from
// splat/itwom3.0.cpp — see wasm/itm/). One ITM evaluation = one point-to-point path loss given a
// terrain profile. Designed to run inside a Web Worker: load() once, then call itmP2P() per path.

import createItmModule, { type ItmModule } from './itm.js';

export type { ItmModule };

export interface ItmInput {
  // Ground elevations along the path, metres ASL, TX->RX. RAW — ITM applies earth curvature itself,
  // so do NOT pre-sag these (unlike the viewshed LOS).
  heights: Float64Array | number[];
  // Spacing between consecutive samples, metres (great-circle ground distance).
  spacingM: number;
  txHeightM: number; // TX antenna AGL
  rxHeightM: number; // RX antenna AGL
  epsDielect: number; // ground dielectric constant
  sgmConductivity: number; // ground conductivity S/m
  ensSurfref: number; // surface refractivity, N-units (atmosphere bending)
  freqMhz: number;
  radioClimate: number; // 1..7 (see itmParams.climateCode)
  pol: number; // 0 horizontal, 1 vertical
  conf: number; // confidence fraction 0.01..0.99 (situation_fraction/100)
  rel: number; // reliability fraction 0.01..0.99 (time_fraction/100)
}

export interface ItmResult {
  pathLossDb: number; // total path loss incl. free space (SPLAT's reported ITM path loss)
  freeSpaceDb: number;
  distanceM: number;
  errnum: number; // 0 ok; 1/3/4 = caution/out-of-range (mirrors ITM kwx)
}

let modulePromise: Promise<ItmModule> | null = null;

// Load (and cache) the WASM module. Safe to call repeatedly; the heavy init runs once.
export function loadItm(): Promise<ItmModule> {
  if (!modulePromise) {
    modulePromise = createItmModule();
  }
  return modulePromise;
}

// Reusable scratch buffers, regrown only when a longer profile needs more room. Avoids a
// malloc/free per path in the per-cell coverage hot loop.
let elevPtr = 0;
let elevCapacity = 0; // in float64 slots
let outPtr = 0;

function ensureBuffers(mod: ItmModule, elevSlots: number): void {
  if (!outPtr) {
    outPtr = mod._malloc(4 * 8);
  }
  if (elevSlots > elevCapacity) {
    if (elevPtr) {
      mod._free(elevPtr);
    }
    elevPtr = mod._malloc(elevSlots * 8);
    elevCapacity = elevSlots;
  }
}

// Run one ITM point-to-point evaluation. `mod` is the resolved module from loadItm().
export function itmP2P(mod: ItmModule, input: ItmInput): ItmResult {
  const n = input.heights.length;
  if (n < 2) {
    throw new Error(`itmP2P needs >= 2 profile points, got ${n}`);
  }
  const elevSlots = n + 2; // [0]=n-1, [1]=spacing, [2..]=heights
  ensureBuffers(mod, elevSlots);

  // HEAPF64 detaches on any growth inside _malloc, so read it AFTER ensureBuffers.
  const heap = mod.HEAPF64;
  const base = elevPtr / 8;
  heap[base] = n - 1;
  heap[base + 1] = input.spacingM;
  for (let i = 0; i < n; i++) {
    heap[base + 2 + i] = input.heights[i];
  }

  mod._itm_p2p(
    elevPtr,
    input.txHeightM,
    input.rxHeightM,
    input.epsDielect,
    input.sgmConductivity,
    input.ensSurfref,
    input.freqMhz,
    input.radioClimate,
    input.pol,
    input.conf,
    input.rel,
    outPtr,
  );

  const out = mod.HEAPF64; // re-read (no growth here, but cheap and safe)
  const ob = outPtr / 8;
  return {
    pathLossDb: out[ob],
    freeSpaceDb: out[ob + 1],
    distanceM: out[ob + 2],
    errnum: Math.round(out[ob + 3]),
  };
}
