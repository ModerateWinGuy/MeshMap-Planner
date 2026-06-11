from pydantic import BaseModel, Field, model_validator
from typing import Optional, Literal


class LinkRequest(BaseModel):
    """
    Input payload for a single point-to-point link analysis (transmitter -> receiver).

    Mirrors the field conventions of CoveragePredictionRequest. Power is in dBm (the frontend
    converts watts -> dBm before sending, matching the coverage flow). Either `lora_preset` or
    `rx_sensitivity` must be supplied so link viability (margin) can be computed; if both are
    given, `rx_sensitivity` wins as an explicit override.
    """

    # Transmitter
    tx_lat: float = Field(ge=-90, le=90, description="Transmitter latitude in degrees")
    tx_lon: float = Field(ge=-180, le=180, description="Transmitter longitude in degrees")
    tx_height: float = Field(1, ge=1, description="Transmitter height above ground in meters (>= 1 m)")
    tx_power: float = Field(gt=0, description="Transmitter power in dBm")
    tx_gain: float = Field(1, ge=0, description="Transmitter antenna gain in dB (>= 0)")

    # Receiver
    rx_lat: float = Field(ge=-90, le=90, description="Receiver latitude in degrees")
    rx_lon: float = Field(ge=-180, le=180, description="Receiver longitude in degrees")
    rx_height: float = Field(1, ge=1, description="Receiver height above ground in meters (>= 1 m)")
    rx_gain: float = Field(1, ge=0, description="Receiver antenna gain in dB (>= 0)")

    # Radio / model
    frequency_mhz: float = Field(905.0, ge=20, le=30000, description="Operating frequency in MHz")
    system_loss: Optional[float] = Field(0.0, ge=0, description="System loss in dB (default: 0.0)")
    clutter_height: float = Field(0, ge=0, description="Ground clutter height in meters (>= 0)")

    # Link budget basis (one of these is required)
    lora_preset: Optional[str] = Field(
        None, description="Meshtastic LoRa modem preset used to derive receiver sensitivity (e.g. 'LongFast')."
    )
    rx_sensitivity: Optional[float] = Field(
        None, le=0, description="Explicit receiver sensitivity in dBm. Overrides lora_preset when set."
    )

    # Environmental
    ground_dielectric: Optional[float] = Field(15.0, ge=1, description="Ground dielectric constant (default: 15.0)")
    ground_conductivity: Optional[float] = Field(0.005, ge=0, description="Ground conductivity in S/m (default: 0.005)")
    atmosphere_bending: Optional[float] = Field(301.0, ge=0, description="Atmospheric bending constant in N-units (default: 301.0)")
    radio_climate: Literal[
        "equatorial",
        "continental_subtropical",
        "maritime_subtropical",
        "desert",
        "continental_temperate",
        "maritime_temperate_land",
        "maritime_temperate_sea",
    ] = Field("continental_temperate", description="Radio climate (default: 'continental_temperate')")
    polarization: Literal["horizontal", "vertical"] = Field(
        "vertical", description="Signal polarization (default: 'vertical')"
    )
    situation_fraction: Optional[float] = Field(50, gt=1, le=100, description="Fraction of situations (default 50).")
    time_fraction: Optional[float] = Field(90, gt=1, le=100, description="Fraction of time (default 90).")

    high_resolution: bool = Field(
        False, description="Use 1-arcsecond / 30 m terrain tiles instead of the default 3-arcsecond / 90 m."
    )
    terrain_source: Literal["srtm", "dem", "dsm"] = Field(
        "srtm", description="Terrain product: 'srtm' (global bare earth, skips LINZ), 'dem' (LINZ bare "
        "earth) or 'dsm' (LINZ surface, includes buildings/canopy). 'dem'/'dsm' only differ over NZ."
    )

    @model_validator(mode="after")
    def _require_sensitivity_basis(self) -> "LinkRequest":
        if self.lora_preset is None and self.rx_sensitivity is None:
            raise ValueError("Either 'lora_preset' or 'rx_sensitivity' must be provided.")
        return self
