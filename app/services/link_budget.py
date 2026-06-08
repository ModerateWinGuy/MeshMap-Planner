"""
LoRa link budget helpers.

Maps a Meshtastic LoRa modem preset to its spreading factor / bandwidth and computes the
thermal-noise-floor receiver sensitivity used to decide whether a point-to-point link is
viable:

    sensitivity_dBm = -174 + 10*log10(bandwidth_Hz) + noise_figure_dB + snr_limit(SF)

This module is intentionally dependency-free (stdlib only) so it can be unit-tested in
isolation and reused by the link matrix, relay siting, and mesh analysis features.

The presets below use the Meshtastic US (915 MHz) defaults. Spreading factor and bandwidth
are what actually drive sensitivity, so the same table is valid for other regions that share
the SF/BW pairing (the centre frequency does not change the noise-floor calculation).
"""

import math
from typing import Dict, NamedTuple


class LoRaPreset(NamedTuple):
    spreading_factor: int
    bandwidth_khz: float


# Meshtastic modem presets -> (spreading factor, bandwidth in kHz).
# Source: Meshtastic LoRa "modem preset" definitions.
PRESET_TABLE: Dict[str, LoRaPreset] = {
    "ShortTurbo": LoRaPreset(7, 500.0),
    "ShortFast": LoRaPreset(7, 250.0),
    "ShortSlow": LoRaPreset(8, 250.0),
    "MediumFast": LoRaPreset(9, 250.0),
    "MediumSlow": LoRaPreset(10, 250.0),
    "LongFast": LoRaPreset(11, 250.0),
    "LongModerate": LoRaPreset(11, 125.0),
    "LongSlow": LoRaPreset(12, 125.0),
}

DEFAULT_PRESET = "LongFast"

# Demodulation SNR limit per spreading factor (dB). These are the well-known Semtech LoRa
# values: the minimum signal-to-noise ratio at which each spreading factor can still be
# demodulated. Lower (more negative) = more sensitive.
SNR_LIMIT_BY_SF: Dict[int, float] = {
    7: -7.5,
    8: -10.0,
    9: -12.5,
    10: -15.0,
    11: -17.5,
    12: -20.0,
}

# Receiver noise figure (dB). ~6 dB is typical for the Semtech SX1262 used by most
# Meshtastic hardware.
NOISE_FIGURE_DB = 6.0


def receiver_sensitivity_dbm(preset_name: str, noise_figure_db: float = NOISE_FIGURE_DB) -> float:
    """
    Compute the receiver sensitivity in dBm for a Meshtastic LoRa modem preset.

    Args:
        preset_name: One of the keys in PRESET_TABLE (e.g. "LongFast").
        noise_figure_db: Receiver noise figure in dB (default ~6 dB for SX1262).

    Returns:
        Receiver sensitivity in dBm (negative; e.g. LongFast ~= -131.5 dBm).

    Raises:
        KeyError: If the preset name is not recognised.
    """
    if preset_name not in PRESET_TABLE:
        raise KeyError(
            f"Unknown LoRa preset '{preset_name}'. Valid presets: {', '.join(PRESET_TABLE)}"
        )

    preset = PRESET_TABLE[preset_name]
    bandwidth_hz = preset.bandwidth_khz * 1000.0
    snr_limit = SNR_LIMIT_BY_SF[preset.spreading_factor]

    # -174 dBm/Hz is the thermal noise floor at room temperature.
    return -174.0 + 10.0 * math.log10(bandwidth_hz) + noise_figure_db + snr_limit
