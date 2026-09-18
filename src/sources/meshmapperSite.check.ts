// Self-check for the site-detail parsers. Run: npm run check:parsers
//
// Every input below is a real value pulled from MeshMapper's live get_repeaters.php payloads, so
// this doubles as the record of what the field actually contains in the wild.

import { parseGainDbi, parseHeightM, parsePowerWatts } from './meshmapperSite.ts';

// A thrown Error is enough to fail the run with a non-zero exit, and keeps this file free of any
// node-typed import so `vue-tsc -b` typechecks it without @types/node.
function eq(got: number | undefined, want: number | undefined, label: string): void {
  if (got !== want) {
    throw new Error(`${label}: got ${got}, want ${want}`);
  }
}

const gains: Array<[unknown, number | undefined]> = [
  ['Alfa 5 dBi', 5],
  ['Alfa 5dB', 5],
  ['10 dBi', 10],
  ['5.8dbi Gizont omnidirectional', 5.8],
  ['Gowifi 6.5db', 6.5],
  ['3db', 3],
  // The model number must not win over the figure carrying the unit.
  ['ANT-281 6dBi', 6],
  ['McGill 4 dBi 868 MHz Tuned Antenna', 4],
  ['Worm', undefined],
  ['', undefined],
  [null, undefined],
];

const powers: Array<[unknown, number | undefined]> = [
  ['0.3W', 0.3],
  ['0.5W', 0.5],
  ['1.0W', 1],
  ['0.158w', 0.158],
  ['1 watt', 1],
  ['158mW', 0.158],
  [' 63 mW', 0.063],
  ['990 mW', 0.99],
  ['Wired, 1w Nebra', 1],
  // Explicit dBm is converted rather than discarded.
  ['22 dBm', 0.158],
  ['30dbm', 1],
  ['22dB', 0.158],
  // Bare figures split on magnitude: watts below the threshold, dBm above it.
  ['0.3', 0.3],
  ['.3', 0.3],
  ['1.0', 1],
  ['22', 0.158],
  ['28', 0.631],
  // Out of any plausible range for a LoRa radio.
  ['160mV', undefined],
  ['40mV', undefined],
  ['', undefined],
  [null, undefined],
];

const heights: Array<[unknown, number | undefined]> = [
  [30, 30],
  [0.5, 0.5],
  [244, 244],
  ['9', 9],
  [0, undefined],
  [-5, undefined],
  [9000, undefined],
  ['', undefined],
  [null, undefined],
];

for (const [input, want] of gains) {
  eq(parseGainDbi(input), want, `gain ${JSON.stringify(input)}`);
}
for (const [input, want] of powers) {
  eq(parsePowerWatts(input), want, `power ${JSON.stringify(input)}`);
}
for (const [input, want] of heights) {
  eq(parseHeightM(input), want, `height ${JSON.stringify(input)}`);
}

console.log(`ok — ${gains.length + powers.length + heights.length} cases`);
