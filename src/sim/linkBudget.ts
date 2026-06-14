// LoRa link-budget helpers — a faithful port of app/services/link_budget.py so client-side link
// viability uses the identical receiver-sensitivity model the backend does.
//
//   sensitivity_dBm = -174 + 10*log10(bandwidth_Hz) + noise_figure_dB + snr_limit(SF)
//
// Spreading factor and bandwidth are what drive sensitivity, so the table is region-independent
// (centre frequency doesn't enter the noise-floor calculation). The preset names match the list in
// store.ts (LORA_PRESETS) and the Python PRESET_TABLE.

export interface LoRaPreset {
  spreadingFactor: number;
  bandwidthKhz: number;
}

// Meshtastic modem presets -> (spreading factor, bandwidth kHz). Mirrors link_budget.PRESET_TABLE.
export const PRESET_TABLE: Record<string, LoRaPreset> = {
  ShortTurbo: { spreadingFactor: 7, bandwidthKhz: 500.0 },
  ShortFast: { spreadingFactor: 7, bandwidthKhz: 250.0 },
  ShortSlow: { spreadingFactor: 8, bandwidthKhz: 250.0 },
  MediumFast: { spreadingFactor: 9, bandwidthKhz: 250.0 },
  MediumSlow: { spreadingFactor: 10, bandwidthKhz: 250.0 },
  LongFast: { spreadingFactor: 11, bandwidthKhz: 250.0 },
  LongModerate: { spreadingFactor: 11, bandwidthKhz: 125.0 },
  LongSlow: { spreadingFactor: 12, bandwidthKhz: 125.0 },
};

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

// ~6 dB is typical for the Semtech SX1262 used by most Meshtastic hardware.
export const NOISE_FIGURE_DB = 6.0;

// Receiver sensitivity in dBm for a Meshtastic modem preset (e.g. LongFast ~= -131.5 dBm).
// Throws on an unknown preset, matching the Python KeyError contract.
export function receiverSensitivityDbm(presetName: string, noiseFigureDb: number = NOISE_FIGURE_DB): number {
  const preset = PRESET_TABLE[presetName];
  if (!preset) {
    throw new Error(`Unknown LoRa preset '${presetName}'. Valid presets: ${Object.keys(PRESET_TABLE).join(', ')}`);
  }
  const bandwidthHz = preset.bandwidthKhz * 1000.0;
  const snrLimit = SNR_LIMIT_BY_SF[preset.spreadingFactor];
  // -174 dBm/Hz is the thermal noise floor at room temperature.
  return -174.0 + 10.0 * Math.log10(bandwidthHz) + noiseFigureDb + snrLimit;
}
