from pydantic import BaseModel, Field, model_validator
from typing import Optional, List, Literal


class MatrixNode(BaseModel):
    """A single node participating in the pairwise link matrix."""

    id: str = Field(description="Stable node identifier (matches the frontend node id).")
    name: Optional[str] = Field(None, description="Human-readable node name (for display).")
    lat: float = Field(ge=-90, le=90, description="Node latitude in degrees")
    lon: float = Field(ge=-180, le=180, description="Node longitude in degrees")
    height: float = Field(1, ge=1, description="Antenna height above ground in meters (>= 1 m)")
    tx_power: float = Field(gt=0, description="Transmitter power in dBm")
    tx_gain: float = Field(1, ge=0, description="Transmitter antenna gain in dB (>= 0)")
    rx_gain: float = Field(1, ge=0, description="Receiver antenna gain in dB (>= 0)")
    frequency_mhz: float = Field(905.0, ge=20, le=30000, description="Operating frequency in MHz")
    system_loss: Optional[float] = Field(0.0, ge=0, description="System loss in dB (default: 0.0)")


class MatrixRequest(BaseModel):
    """
    Input payload for /matrix. Computes every unordered pair of nodes as a point-to-point link.

    All interconnecting nodes are assumed to share one LoRa modem config, so a single
    `lora_preset` (or explicit `rx_sensitivity`) determines the receiver sensitivity used for
    every pair. Pairs are treated as symmetric (LoRa links are ~symmetric when params match);
    node A is used as the transmitter for each pair and node B's `rx_gain` is added to the
    received power.
    """

    nodes: List[MatrixNode] = Field(min_length=2, max_length=25, description="Nodes to link (2-25).")

    # Link budget basis (one required)
    lora_preset: Optional[str] = Field(None, description="LoRa modem preset (e.g. 'LongFast').")
    rx_sensitivity: Optional[float] = Field(None, le=0, description="Explicit receiver sensitivity in dBm; overrides lora_preset.")

    # Shared environmental / model params (applied to every pair)
    clutter_height: float = Field(0, ge=0, description="Ground clutter height in meters (>= 0)")
    ground_dielectric: Optional[float] = Field(15.0, ge=1, description="Ground dielectric constant")
    ground_conductivity: Optional[float] = Field(0.005, ge=0, description="Ground conductivity in S/m")
    atmosphere_bending: Optional[float] = Field(301.0, ge=0, description="Atmospheric bending constant in N-units")
    radio_climate: Literal[
        "equatorial",
        "continental_subtropical",
        "maritime_subtropical",
        "desert",
        "continental_temperate",
        "maritime_temperate_land",
        "maritime_temperate_sea",
    ] = Field("continental_temperate", description="Radio climate")
    polarization: Literal["horizontal", "vertical"] = Field("vertical", description="Signal polarization")
    situation_fraction: Optional[float] = Field(50, gt=1, le=100, description="Fraction of situations (default 50).")
    time_fraction: Optional[float] = Field(90, gt=1, le=100, description="Fraction of time (default 90).")
    high_resolution: bool = Field(False, description="Use 1-arcsecond / 30 m terrain tiles.")
    terrain_source: Literal["dem", "dsm"] = Field(
        "dem", description="Terrain product where a high-res source offers it (e.g. NZ LINZ): 'dem' "
        "(bare earth) or 'dsm' (surface). Ignored by SRTM."
    )

    @model_validator(mode="after")
    def _require_sensitivity_basis(self) -> "MatrixRequest":
        if self.lora_preset is None and self.rx_sensitivity is None:
            raise ValueError("Either 'lora_preset' or 'rx_sensitivity' must be provided.")
        return self
