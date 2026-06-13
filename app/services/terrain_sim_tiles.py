"""
Web-mercator XYZ tiles that render the *exact* terrain SPLAT! analyses.

The 3D map normally shows high-resolution terrain (LINZ down to ~3.6 m, or AWS Terrarium), but
SPLAT! computes line-of-sight against a downsampled SDF grid capped at 1 arc-second (~30 m,
high-res) or 3 arc-second (~90 m, default). So a node can look clear on the smooth map while SPLAT
sees a coarse cell poking into the path — the source of "phantom" coverage shadows.

This service serves the SDF grid itself as terrarium raster-dem tiles, sampled **nearest-neighbour**
so every SDF post renders as a flat quad with sharp edges — the blocky surface SPLAT actually uses.
It decodes the very bytes SPLAT! reads (via the shared DEM provider chain / per-cell SDF cache), so
it routes exactly as a prediction would: 'srtm' → SRTM, 'dem'/'dsm' → LINZ over NZ (SRTM fallback
elsewhere). Anything it can't serve (ocean cell, build failure) returns ``None`` and the route
307-redirects to AWS Terrarium, so the single MapLibre terrain source is never left with a hole.

Resolution is in the URL (``sd``/``hd``) rather than inferred, because the map source's resolution
follows the simulation's High-Resolution toggle independently of which tile is requested.
"""

import logging
import math
import threading
from collections import OrderedDict
from typing import Mapping, Optional, Tuple

import numpy as np
from diskcache import Cache

from app.services.dem_providers.base import TerrainTile
from app.services.terrain_tiles import tiles_for_bbox
from app.services.terrain_tiles_xyz import (
    TILE_SIZE,
    encode_terrarium_png,
    tile_to_mercator_bbox,
    tile_to_wgs84_bbox,
)

logger = logging.getLogger(__name__)

# Spherical web-mercator radius (EPSG:3857), matching tile_to_mercator_bbox.
_MERC_R = 6378137.0
# SDF posts per degree by resolution. srtm2sdf emits ippd² values (it drops the northern row and
# eastern column), so a high-res cell is 3600×3600 and a standard cell 1200×1200.
_IPPD = {"sd": 1200, "hd": 3600}


def decode_sdf(sdf_bytes: bytes) -> np.ndarray:
    """Decode SPLAT! ``.sdf`` bytes into a square elevation grid ``g[a][b]`` (metres, int16).

    SDF layout (``srtm2sdf.c`` WriteSDF / ``splat.cpp`` LoadSDF_SDF): 4 ASCII integer header lines
    (``max_west, min_north, min_west, max_north`` — longitudes west-positive) then ``ippd²`` signed
    integer elevations, one per line. SPLAT! reads them into ``data[x][y]`` in x-outer/y-inner order;
    reshaped row-major that gives ``g[a][b]`` where ``a`` runs **south→north** and ``b`` runs
    **east→west** from the cell's SW corner. Verified empirically against a known landmark (Kapiti
    Island's 520 m peak lands at its true lat/lon), so :func:`sample_grid` maps lat/lon accordingly.
    """
    parts = sdf_bytes.split(b"\n", 4)
    if len(parts) < 5:
        raise ValueError("SDF too short: missing the 4-line header")
    arr = np.array(parts[4].split(), dtype=np.int16)
    ippd = int(round(math.sqrt(arr.size)))
    if ippd * ippd != arr.size:
        raise ValueError(f"SDF body is {arr.size} values, not a square grid")
    return arr.reshape(ippd, ippd)


def sample_grid(grid: np.ndarray, cell_lat: int, cell_lon: int, lats: np.ndarray, lons: np.ndarray):
    """Nearest-neighbour elevations from a decoded cell grid at the given lat/lon arrays.

    ``cell_lat``/``cell_lon`` are the cell's SW corner (south/west edges). ``a`` indexes latitude
    from the south edge, ``b`` indexes longitude from the *east* edge (see :func:`decode_sdf`).
    """
    ippd = grid.shape[0]
    a = np.clip(np.rint((lats - cell_lat) * ippd).astype(np.intp), 0, ippd - 1)
    b = np.clip((ippd - 1) - np.rint((lons - cell_lon) * ippd).astype(np.intp), 0, ippd - 1)
    return grid[a, b]


class TerrainSimService:
    """Renders/caches terrarium XYZ tiles of the SPLAT! SDF grid, with a Terrarium fallback.

    A ``None`` return from :meth:`render_tile` means "I can't serve this" — the route turns that into
    a 307 redirect to AWS Terrarium so the map source stays hole-free.
    """

    def __init__(self, splat_service, cache_dir: str, cache_size_gb: float, ttl_days: int, grid_lru: int = 8):
        self.splat = splat_service  # provides get_sdf_bytes(tile) through the DEM provider chain
        self.expire = (ttl_days * 86400) if ttl_days > 0 else None
        # Dedicated PNG cache subdir so sim-tile churn never evicts the LIDAR tile cache or the SDF
        # cell cache (both under SPLAT_CACHE_DIR).
        self.cache = Cache(
            f"{cache_dir.rstrip('/')}/sim_xyz",
            size_limit=int(cache_size_gb * 1024 * 1024 * 1024),
            eviction_policy="least-recently-used",
        )
        # In-memory LRU of decoded cell grids: a single zoomed-out tile straddles up to 4 cells and
        # adjacent tiles share cells, so decode each ~13 M-value HD grid once and reuse it. Guarded
        # by a lock because render_tile runs in a threadpool. Values are the grid, or None (cached
        # negative: an ocean/no-data cell shouldn't be re-attempted for every tile).
        self._grids: "OrderedDict[Tuple[str, str, int, int], Optional[np.ndarray]]" = OrderedDict()
        self._grid_lru = grid_lru
        self._lock = threading.Lock()
        logger.info(
            "Terrain SIM tiles ready (cache '%s/sim_xyz' limit %.0f GB, ttl=%s, grid LRU=%d).",
            cache_dir, cache_size_gb, self.expire, grid_lru,
        )

    @classmethod
    def from_env(cls, splat_service, env: Mapping[str, str]) -> "TerrainSimService":
        return cls(
            splat_service=splat_service,
            cache_dir=env.get("SPLAT_CACHE_DIR", ".splat_tiles"),
            cache_size_gb=float(env.get("SIM_TILE_CACHE_GB", env.get("LINZ_TILE_CACHE_GB", "10"))),
            ttl_days=int(env.get("LINZ_TILE_TTL_DAYS", "180")),
        )

    def _cell_grid(self, source: str, res: str, tile: TerrainTile) -> Optional[np.ndarray]:
        """Decoded grid for one cell, memoised. Returns None when no provider can serve the cell
        (or it fails to build/decode) so the caller leaves those pixels uncovered."""
        key = (source, res, tile.lat, tile.lon)
        with self._lock:
            if key in self._grids:
                self._grids.move_to_end(key)
                return self._grids[key]
        # Build outside the lock — get_sdf_bytes may do slow network/COG work; we don't want to
        # serialise every tile behind one cold cell.
        grid: Optional[np.ndarray] = None
        try:
            sdf = self.splat.get_sdf_bytes(tile)
            if sdf is not None:
                grid = decode_sdf(sdf)
        except Exception as e:  # noqa: BLE001 — degrade to Terrarium, never 500 a map tile.
            logger.warning("SIM tile: cell (%d,%d) %s/%s unavailable: %s", tile.lat, tile.lon, source, res, e)
            grid = None
        with self._lock:
            self._grids[key] = grid
            self._grids.move_to_end(key)
            while len(self._grids) > self._grid_lru:
                self._grids.popitem(last=False)
        return grid

    def render_tile(self, source: str, res: str, z: int, x: int, y: int) -> Optional[bytes]:
        """PNG bytes for the tile, or ``None`` to signal the route to redirect to Terrarium.

        Blocking (may build an SDF) — call from a threadpool so it can't stall the event loop.
        """
        if source not in ("srtm", "dem", "dsm") or res not in _IPPD:
            return None

        cache_key = f"{source}:{res}:{z}:{x}:{y}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached

        high_resolution = res == "hd"
        west, south, east, north = tile_to_wgs84_bbox(z, x, y)
        _, miny, _, maxy = tile_to_mercator_bbox(z, x, y)

        # Per-pixel lon is linear across a mercator tile; per-pixel lat is not, so derive it from the
        # mercator-y of each row (row 0 = north/top).
        col = np.arange(TILE_SIZE) + 0.5
        lons_1d = west + col * (east - west) / TILE_SIZE
        ys = maxy - col * (maxy - miny) / TILE_SIZE
        lats_1d = np.degrees(2.0 * np.arctan(np.exp(ys / _MERC_R)) - math.pi / 2.0)
        lon_grid, lat_grid = np.meshgrid(lons_1d, lats_1d)  # (TILE_SIZE, TILE_SIZE)

        elev = np.zeros((TILE_SIZE, TILE_SIZE), dtype=np.float32)
        covered = np.zeros((TILE_SIZE, TILE_SIZE), dtype=bool)

        for tile_tuple in tiles_for_bbox(west, south, east, north):
            cell = TerrainTile.from_tile_tuple(tile_tuple, high_resolution, source)
            in_cell = (np.floor(lat_grid).astype(int) == cell.lat) & (np.floor(lon_grid).astype(int) == cell.lon)
            if not in_cell.any():
                continue
            grid = self._cell_grid(source, res, cell)
            if grid is None:
                continue
            elev[in_cell] = sample_grid(grid, cell.lat, cell.lon, lat_grid[in_cell], lon_grid[in_cell])
            covered |= in_cell

        if not covered.any():
            return None  # nothing the simulation has terrain for here → Terrarium

        png = encode_terrarium_png(elev)
        self.cache.set(cache_key, png, expire=self.expire)
        return png
