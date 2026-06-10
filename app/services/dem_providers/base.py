"""
The DEM-provider contract.

A ``DEMProvider`` turns a 1-degree terrain cell into a SPLAT! ``.sdf`` tile (or declines, so the
next provider in the chain is tried). New terrain sources are added by implementing this ABC in a
new module, decorating it with ``@register_provider``, and adding its ``name`` to the
``DEM_PROVIDERS`` config order — nothing in ``splat.py`` or the other providers changes.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Mapping, Optional

from app.services.terrain_tiles import hgt_to_sdf_filename, parse_hgt_cell


@dataclass(frozen=True)
class TerrainTile:
    """A single 1-degree terrain cell a provider is asked to supply.

    Carries the cell geometry (not just a filename) so providers that need a bounding box — e.g.
    to reproject or to test coverage — have it directly, and the contract stays stable as new
    providers need new facts about the cell.
    """

    lat: int                 # south-west corner of the 1-degree cell, signed degrees
    lon: int                 # south-west corner of the 1-degree cell, signed degrees
    sdf_filename: str        # canonical name SPLAT! expects, e.g. "35:36:-120:-119-hd.sdf"
    hgt_name: str            # SRTM-style name, e.g. "N35W120.hgt.gz", for sources keyed that way
    high_resolution: bool    # 1-arcsec / -hd.sdf when True, else 3-arcsec / .sdf
    terrain_source: str      # "dem" | "dsm"; providers that don't distinguish ignore it

    @classmethod
    def from_tile_tuple(
        cls,
        tile_tuple: "tuple[str, str, str]",
        high_resolution: bool,
        terrain_source: str,
    ) -> "TerrainTile":
        """Build from a ``(hgt_name, sdf_name, sdf_hd_name)`` tuple as produced by
        ``app.services.terrain_tiles``."""
        hgt_name, sdf_name, sdf_hd_name = tile_tuple
        lat, lon = parse_hgt_cell(hgt_name)
        return cls(
            lat=lat,
            lon=lon,
            sdf_filename=(sdf_hd_name if high_resolution else sdf_name),
            hgt_name=hgt_name,
            high_resolution=high_resolution,
            terrain_source=terrain_source,
        )

    @property
    def sdf_for(self) -> str:
        """Convenience: the SDF name for this tile's resolution (same as ``sdf_filename``)."""
        return self.sdf_filename


class DEMProvider(ABC):
    """A source of SPLAT! ``.sdf`` terrain tiles.

    Precedence is positional: providers are consulted in ``DEM_PROVIDERS`` order and the first to
    return bytes wins.
    """

    #: Unique registry key, e.g. ``"linz"``. Set as a class attribute on each concrete provider.
    name: str = ""

    @classmethod
    @abstractmethod
    def from_env(cls, env: Mapping[str, str]) -> "DEMProvider":
        """Construct from environment/config.

        Each provider reads its own ``NAME_*`` namespace (e.g. ``LINZ_*``, ``LOCAL_SDF_DIR``) so
        configuration is self-contained per source and adding one never touches shared wiring.
        """

    @abstractmethod
    def try_get_sdf(self, tile: TerrainTile) -> Optional[bytes]:
        """Return SDF bytes for ``tile``, or ``None`` to defer to the next provider.

        Contract:
          - Return ``None`` for "outside my coverage / I can't serve this" — cheaply, ideally
            without network I/O, and **without** raising.
          - Raise only on genuine failures (network, conversion) that should surface as an error.
          - Own your caching, keyed so it cannot collide with other sources on the shared SDF
            name (e.g. prefix keys with ``name`` and ``terrain_source``).
        """
