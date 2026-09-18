// Parsers for MeshMapper's owner-entered site details (antenna / power / height). Every one of these
// is free text typed into a form, so the same figure arrives as "0.3W", "158mW", "22 dBm" or "Alfa
// 5 dBi" — and sometimes as "Worm". Each parser returns undefined for anything it can't read with
// confidence, and the import then keeps the app default rather than guessing.
//
// Deliberately import-free so the self-check beside it runs under bare node (see .check.ts).

// A LoRa radio's plausible transmit range in watts. Used to reject parses that land somewhere absurd
// ("160mV" → garbage) rather than import a node that silently skews every link it touches.
const MIN_WATTS = 0.001;
const MAX_WATTS = 5;
// A bare, unitless power figure above this reads as dBm: a LoRa radio is never 22 W, but 22 dBm is
// the stock SX1262 maximum. Below it, the figure is taken as watts (the form's own unit).
const BARE_WATT_MAX = 5;

const dbmToWatts = (dbm: number): number => 10 ** ((dbm - 30) / 10);

// Metres above ground. The one detail MeshMapper stores as a real number, but tolerate a string.
export function parseHeightM(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 500 ? n : undefined;
}

// Antenna gain in dBi, pulled out of a free-text description ("Alfa 5 dBi", "3db", "ANT-281 6dBi").
// Matches the number actually attached to a dB unit, not the first number in the string, so a model
// number can't be read as a gain.
export function parseGainDbi(raw: unknown): number | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const m = /(-?\d*\.?\d+)\s*db/i.exec(raw);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= -10 && n <= 30 ? n : undefined;
}

// Transmit power in watts, which is what Node.transmitter.tx_power stores. Honours an explicit unit
// when the owner typed one (mW, W, dBm) and falls back to the magnitude split above otherwise.
export function parsePowerWatts(raw: unknown): number | undefined {
  const m = /(-?\d*\.?\d+)\s*(mw|w|watt|dbm|db)?/i.exec(String(raw ?? ''));
  if (!m) {
    return undefined;
  }
  let watts = Number(m[1]);
  if (!Number.isFinite(watts)) {
    return undefined;
  }
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'mw') {
    watts /= 1000;
  } else if (unit.startsWith('db')) {
    watts = dbmToWatts(watts);
  } else if (!unit && watts > BARE_WATT_MAX) {
    watts = dbmToWatts(watts);
  }
  // Same 3dp rounding the transmitter panel's own dBm box applies, so a synced node and a hand-typed
  // one land on the same value.
  return watts >= MIN_WATTS && watts <= MAX_WATTS ? Number(watts.toFixed(3)) : undefined;
}
