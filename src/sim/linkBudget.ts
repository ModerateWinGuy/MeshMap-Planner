// LoRa link-budget helpers for client-side link viability.
//
//   sensitivity_dBm = -174 + 10*log10(bandwidth_Hz) + noise_figure_dB + snr_limit(SF)
//
// Spreading factor and bandwidth are what drive sensitivity, so the formula is region-independent
// (centre frequency doesn't enter the noise-floor calculation). Frequency is still carried on
// MeshCore presets (unlike Meshtastic, whose presets are pure modem speed with frequency set
// independently per node) so a new node can default to the right region.

export interface LoRaPreset {
  spreadingFactor: number;
  bandwidthKhz: number;
  frequencyMhz?: number;
}

// Meshtastic modem presets -> (spreading factor, bandwidth kHz). Frequency is a separate,
// independent per-node setting in Meshtastic, so it's left unset here.
export const MESHTASTIC_PRESETS: Record<string, LoRaPreset> = {
  ShortTurbo: { spreadingFactor: 7, bandwidthKhz: 500.0 },
  ShortFast: { spreadingFactor: 7, bandwidthKhz: 250.0 },
  ShortSlow: { spreadingFactor: 8, bandwidthKhz: 250.0 },
  MediumFast: { spreadingFactor: 9, bandwidthKhz: 250.0 },
  MediumSlow: { spreadingFactor: 10, bandwidthKhz: 250.0 },
  LongFast: { spreadingFactor: 11, bandwidthKhz: 250.0 },
  LongModerate: { spreadingFactor: 11, bandwidthKhz: 125.0 },
  LongSlow: { spreadingFactor: 12, bandwidthKhz: 125.0 },
};

// MeshCore's named "Select Radio Settings" list (region presets bundle frequency + modem speed).
// Source: the MeshCore companion app's radio settings picker.
export const MESHCORE_PRESETS: Record<string, LoRaPreset> = {
  'Australia': { frequencyMhz: 915.8, spreadingFactor: 10, bandwidthKhz: 250 },
  'Australia (Narrow)': { frequencyMhz: 916.575, spreadingFactor: 7, bandwidthKhz: 62.5 },
  'Australia (Mid)': { frequencyMhz: 915.075, spreadingFactor: 9, bandwidthKhz: 125 },
  'Australia: SA, WA': { frequencyMhz: 923.125, spreadingFactor: 8, bandwidthKhz: 62.5 },
  'Australia: QLD': { frequencyMhz: 923.125, spreadingFactor: 8, bandwidthKhz: 62.5 },
  'Brazil': { frequencyMhz: 923.125, spreadingFactor: 8, bandwidthKhz: 62.5 },
  'EU/UK (Narrow)': { frequencyMhz: 869.618, spreadingFactor: 8, bandwidthKhz: 62.5 },
  'EU/UK (Deprecated)': { frequencyMhz: 869.525, spreadingFactor: 11, bandwidthKhz: 250 },
  'Czech Republic (Narrow)': { frequencyMhz: 869.432, spreadingFactor: 7, bandwidthKhz: 62.5 },
  'EU 433MHz (Long Range)': { frequencyMhz: 433.65, spreadingFactor: 11, bandwidthKhz: 250 },
  'EU 433MHz (Narrow)': { frequencyMhz: 433.65, spreadingFactor: 8, bandwidthKhz: 62.5 },
  'Netherlands': { frequencyMhz: 869.618, spreadingFactor: 7, bandwidthKhz: 62.5 },
  'New Zealand': { frequencyMhz: 917.375, spreadingFactor: 11, bandwidthKhz: 250 },
  'New Zealand (Narrow)': { frequencyMhz: 917.375, spreadingFactor: 7, bandwidthKhz: 62.5 },
  'Portugal 433': { frequencyMhz: 433.375, spreadingFactor: 9, bandwidthKhz: 62.5 },
  'Portugal 868': { frequencyMhz: 869.618, spreadingFactor: 7, bandwidthKhz: 62.5 },
  'Switzerland': { frequencyMhz: 869.618, spreadingFactor: 8, bandwidthKhz: 62.5 },
  'USA/Canada (Recommended)': { frequencyMhz: 910.525, spreadingFactor: 7, bandwidthKhz: 62.5 },
  'Vietnam (Narrow)': { frequencyMhz: 920.25, spreadingFactor: 8, bandwidthKhz: 62.5 },
  'Vietnam (Deprecated)': { frequencyMhz: 920.25, spreadingFactor: 11, bandwidthKhz: 250 },
};

export const PRESET_TABLE: Record<string, LoRaPreset> = { ...MESHTASTIC_PRESETS, ...MESHCORE_PRESETS };

export const DEFAULT_PRESET = 'LongFast';

// Semtech LoRa demodulation SNR limit per spreading factor (dB): the minimum SNR each SF can still
// demodulate. Lower (more negative) = more sensitive.
const SNR_LIMIT_BY_SF: Record<number, number> = {
  7: -7.5,
  8: -10.0,
  9: -12.5,
  10: -15.0,
  11: -17.5,
  12: -20.0,
};

const MIN_SF = 7;
const MAX_SF = 12;

// ~6 dB is typical for the Semtech SX1262 used by most Meshtastic and MeshCore hardware.
export const NOISE_FIGURE_DB = 6.0;

// Receiver sensitivity in dBm for a given spreading factor / bandwidth (e.g. Meshtastic's LongFast,
// SF11+250kHz, is ~= -131.5 dBm). Takes the raw values rather than a preset name so a hand-edited,
// non-preset SF/BW pair feeds the same sim path. SF is clamped into the supported 7-12 range rather
// than throwing, since this runs on every keystroke of a free-text input.
export function receiverSensitivityDbm(
  spreadingFactor: number,
  bandwidthKhz: number,
  noiseFigureDb: number = NOISE_FIGURE_DB
): number {
  const sf = Math.min(MAX_SF, Math.max(MIN_SF, Math.round(spreadingFactor)));
  const bandwidthHz = bandwidthKhz * 1000.0;
  const snrLimit = SNR_LIMIT_BY_SF[sf];
  // -174 dBm/Hz is the thermal noise floor at room temperature.
  return -174.0 + 10.0 * Math.log10(bandwidthHz) + noiseFigureDb + snrLimit;
}

// Reverse-lookup: the preset name whose SF/BW exactly match the given values, or null if the
// current values are a custom (non-preset) combination.
export function presetNameFor(spreadingFactor: number, bandwidthKhz: number): string | null {
  for (const [name, preset] of Object.entries(PRESET_TABLE)) {
    if (preset.spreadingFactor === spreadingFactor && preset.bandwidthKhz === bandwidthKhz) {
      return name;
    }
  }
  return null;
}
