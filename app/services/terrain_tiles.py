"""
Pure terrain-tile naming and coverage helpers, shared by the SPLAT! service and every DEM
provider.

This module is deliberately dependency-free (stdlib only) and imports nothing from `splat` or
the `dem_providers` package, so it can be the single source of truth for tile naming without
creating an import cycle between the service and its providers.

A 1-degree cell has three names that all describe the same patch of ground:
    - the SRTM ``.hgt.gz`` tile name  (e.g. ``N35W120.hgt.gz``)        — how AWS SRTM is keyed
    - the SPLAT! ``.sdf`` name        (e.g. ``35:36:-120:-119.sdf``)   — what SPLAT! reads by
    - the SPLAT! ``-hd.sdf`` name     (e.g. ``35:36:-120:-119-hd.sdf``)
The ``.sdf`` name is what SPLAT! looks for in its working directory regardless of which data
source produced it, so every provider must emit exactly this name.
"""

import logging
import math
from typing import List, Tuple

logger = logging.getLogger(__name__)


def hgt_to_sdf_filename(hgt_filename: str, high_resolution: bool = False) -> str:
    """Map an SRTM ``.hgt.gz`` tile name to the SPLAT! ``.sdf`` / ``-hd.sdf`` name it produces.

    This mirrors srtm2sdf's own output naming (``min_north:max_north:min_west:max_west``), so the
    name returned here is exactly what SPLAT! will look for in its working directory.
    """
    lat = int(hgt_filename[1:3]) * (1 if hgt_filename[0] == "N" else -1)
    # Fix an off-by-one in the eastern hemisphere (SPLAT! measures longitude west-positive).
    min_lon = int(hgt_filename[4:7]) - (-1 if hgt_filename[3] == "E" else 1)
    min_lon = 360 - min_lon if hgt_filename[3] == "E" else min_lon
    max_lon = 0 if min_lon == 359 else min_lon + 1
    return f"{lat}:{lat + 1}:{min_lon}:{max_lon}{'-hd.sdf' if high_resolution else '.sdf'}"


def sdf_disk_name(sdf_filename: str) -> str:
    """Filesystem-safe form of a SPLAT! ``.sdf`` name for hosts that forbid ``:`` (Windows).

    SPLAT! SDF names use ``:`` only as field separators (``lat:lat:lon:lon``) and the names never
    otherwise contain ``_``, so ``:`` <-> ``_`` is an unambiguous, reversible substitution. SPLAT!
    itself always sees the real colon name in its (Linux) working directory; this safe form is only
    for *staging* tiles on disk (e.g. a Windows host, or baked into the image).
    """
    return sdf_filename.replace(":", "_")


def sdf_disk_aliases(sdf_filename: str) -> List[str]:
    """Names a stored local ``.sdf`` might use, in lookup order: the literal SPLAT! name (created on
    Linux) and the filesystem-safe form (created on Windows). Deduplicated when they're identical."""
    safe = sdf_disk_name(sdf_filename)
    return [sdf_filename] if safe == sdf_filename else [sdf_filename, safe]


def parse_hgt_cell(hgt_filename: str) -> Tuple[int, int]:
    """Return the south-west corner ``(lat, lon)`` of the 1-degree cell named by ``hgt_filename``.

    Standard signed degrees (north/east positive), e.g. ``S41E174.hgt.gz`` -> ``(-41, 174)``,
    a cell spanning lat ``[-41, -40]`` and lon ``[174, 175]``.
    """
    lat = int(hgt_filename[1:3]) * (1 if hgt_filename[0] == "N" else -1)
    lon = int(hgt_filename[4:7]) * (1 if hgt_filename[3] == "E" else -1)
    return lat, lon


def _tiles_for_bounds(
    lat_min_tile: int, lat_max_tile: int, lon_min_tile: int, lon_max_tile: int
) -> List[Tuple[str, str, str]]:
    """Build the (hgt.gz, sdf, sdf-hd) tuples for every 1-degree cell in the inclusive bounds."""
    tiles: List[Tuple[str, str, str]] = []
    for lat_tile in range(lat_min_tile, lat_max_tile + 1):
        for lon_tile in range(lon_min_tile, lon_max_tile + 1):
            ns = "N" if lat_tile >= 0 else "S"
            ew = "E" if lon_tile >= 0 else "W"
            hgt_name = f"{ns}{abs(lat_tile):02d}{ew}{abs(lon_tile):03d}.hgt.gz"
            tiles.append(
                (
                    hgt_name,
                    hgt_to_sdf_filename(hgt_name, high_resolution=False),
                    hgt_to_sdf_filename(hgt_name, high_resolution=True),
                )
            )
    return tiles


def calculate_required_tiles(lat: float, lon: float, radius: float) -> List[Tuple[str, str, str]]:
    """All 1-degree terrain tiles covering a circle of ``radius`` metres around ``(lat, lon)``.

    Returns ``(hgt.gz, sdf, sdf-hd)`` tuples; SPLAT! requires these exact filenames.
    """
    earth_radius = 6378137  # metres, approximate.
    delta_deg = (radius / earth_radius) * (180 / math.pi)

    lat_min = lat - delta_deg
    lat_max = lat + delta_deg
    lon_min = lon - delta_deg / math.cos(math.radians(lat))
    lon_max = lon + delta_deg / math.cos(math.radians(lat))

    tiles = _tiles_for_bounds(
        math.floor(lat_min), math.floor(lat_max), math.floor(lon_min), math.floor(lon_max)
    )
    logger.debug("required tile names are: %s", tiles)
    return tiles


def tiles_for_bbox(
    west: float, south: float, east: float, north: float
) -> List[Tuple[str, str, str]]:
    """1-degree tiles covering a lon/lat bounding box (no radius/circle maths).

    Returns the same ``(hgt.gz, sdf, sdf-hd)`` tuple shape as :func:`calculate_required_tiles`, so
    the elevation overlay reads exactly the tiles a coverage prediction would build and shares the
    SDF cache with them.
    """
    return _tiles_for_bounds(
        math.floor(south), math.floor(north), math.floor(west), math.floor(east)
    )


def calculate_p2p_tiles(
    lat1: float, lon1: float, lat2: float, lon2: float, pad_deg: float = 0.1
) -> List[Tuple[str, str, str]]:
    """1-degree tiles covering the bounding box of two endpoints plus a small margin.

    Returns the same ``(hgt.gz, sdf, sdf-hd)`` tuple shape as :func:`calculate_required_tiles`
    so the tile cache is shared with coverage predictions.
    """
    tiles = _tiles_for_bounds(
        math.floor(min(lat1, lat2) - pad_deg),
        math.floor(max(lat1, lat2) + pad_deg),
        math.floor(min(lon1, lon2) - pad_deg),
        math.floor(max(lon1, lon2) + pad_deg),
    )
    logger.debug("required P2P tile names are: %s", tiles)
    return tiles
