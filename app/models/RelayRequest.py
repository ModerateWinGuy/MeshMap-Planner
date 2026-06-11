from pydantic import BaseModel, Field, model_validator
from typing import Optional, List, Literal

from app.models.MatrixRequest import MatrixNode


class RelayRequest(BaseModel):
    """
    Input payload for /relay. Finds the "candidate relay zone" between two nodes: every
    location that receives BOTH node A and node B above the LoRa receiver sensitivity.

    The backend runs a SPLAT! coverage pass from each node, intersects the two signal fields,
    and ranks locations by `min(marginA, marginB)` (the limiting hop). Both nodes are assumed
    to share one LoRa modem config, so a single `lora_preset` (or explicit `rx_sensitivity`)
    determines the receiver sensitivity. The hypothetical relay's receive gain (`relay_rx_gain`)
    is added to both legs.
    """

    node_a: MatrixNode = Field(description="First endpoint node.")
    node_b: MatrixNode = Field(description="Second endpoint node.")

    # Link budget basis (one required) — mirrors MatrixRequest.
    lora_preset: Optional[str] = Field(None, description="LoRa modem preset (e.g. 'LongFast').")
    rx_sensitivity: Optional[float] = Field(None, le=0, description="Explicit receiver sensitivity in dBm; overrides lora_preset.")

    # Hypothetical relay receiver antenna gain (dB), added to both legs' margins.
    relay_rx_gain: float = Field(2.0, ge=0, description="Relay receive antenna gain in dB (>= 0).")

    # Search geometry: each node's coverage pass uses this radius (capped at 100 km like coverage).
    search_radius_m: float = Field(30000.0, ge=1, le=100000, description="Per-site coverage search radius in meters (<= 100 km).")
    top_n: int = Field(5, ge=1, le=50, description="Number of suggested relay points to return.")

    # Margin band edges (dB). Cells are coloured by which band their min-margin falls into.
    band_edges_db: List[float] = Field(default_factory=lambda: [0.0, 10.0, 20.0], description="Ascending margin band edges in dB.")

    # Shared environmental / model params (applied to both passes) — copied from MatrixRequest.
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
    terrain_source: Literal["srtm", "dem", "dsm"] = Field(
        "srtm", description="Terrain product: 'srtm' (global bare earth, skips LINZ), 'dem' (LINZ bare "
        "earth) or 'dsm' (LINZ surface). 'dem'/'dsm' only differ over NZ."
    )

    @model_validator(mode="after")
    def _require_sensitivity_basis(self) -> "RelayRequest":
        if self.lora_preset is None and self.rx_sensitivity is None:
            raise ValueError("Either 'lora_preset' or 'rx_sensitivity' must be provided.")
        return self

    @model_validator(mode="after")
    def _require_ascending_bands(self) -> "RelayRequest":
        if self.band_edges_db != sorted(self.band_edges_db):
            raise ValueError("'band_edges_db' must be in ascending order.")
        return self
