"""
Web-mercator XYZ terrain tiles for the 3D map.

Serves terrarium-encoded raster-dem PNG tiles so the MapLibre 3D terrain renders the *same* LINZ
surface the RF simulation computes against (DEM bare-earth or DSM surface) over New Zealand, instead
of the generic AWS Terrarium baseline. It mirrors the simulation provider chain: inside NZ it reads
the LINZ LIDAR COGs (reusing the LINZ provider's cached STAC discovery), reprojects a single tile to
web-mercator, and terrarium-encodes it; for anything it can't serve (outside NZ, below the minzoom
gate, above the per-source maxzoom cap, or on any failure) it returns ``None`` and the route falls
back to a redirect to AWS Terrarium — so the single MapLibre source is never left with a hole.

The simulation downsamples LINZ to the ~30 m SDF grid; here the read targets the 256x256 tile
resolution directly so GDAL pulls the COG's nearest internal overview — a zoomed-out tile reads a
cheap decimated level, not full 1 m data. The per-source maxzoom (DEM z15 ≈3.6 m, DSM z14 ≈7 m) is
what bounds the finest read.
"""

import io
import logging
import math
import os
from typing import List, Optional, Tuple

import numpy as np
import rasterio
from diskcache import Cache
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT

from app.services.dem_providers.linz import _GDAL_VSICURL_ENV

logger = logging.getLogger(__name__)

TILE_SIZE = 256
# Half the web-mercator world extent in metres (EPSG:3857): pi * earth radius.
_MERC_ORIGIN = math.pi * 6378137.0
# Sentinel for "no LINZ data here" while compositing; well outside any real NZ elevation so it can't
# be mistaken for ground, and uncovered pixels read back as flat sea level (0 m) after the fill.
_NODATA = -1.0e6
_TERRARIUM_OFFSET = 32768.0


# --------------------------------------------------------------------------- #
# Pure tile geometry (stdlib only) — easy to unit-test.
# --------------------------------------------------------------------------- #
def tile_to_mercator_bbox(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    """Web-mercator (EPSG:3857) ``(minx, miny, maxx, maxy)`` metres for an XYZ tile."""
    n = 2 ** z
    size = (2 * _MERC_ORIGIN) / n
    minx = -_MERC_ORIGIN + x * size
    maxx = -_MERC_ORIGIN + (x + 1) * size
    maxy = _MERC_ORIGIN - y * size
    miny = _MERC_ORIGIN - (y + 1) * size
    return (minx, miny, maxx, maxy)


def tile_to_wgs84_bbox(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    """WGS84 ``(west, south, east, north)`` degrees for an XYZ tile (for the coverage gate)."""
    n = 2 ** z
    lon_w = x / n * 360.0 - 180.0
    lon_e = (x + 1) / n * 360.0 - 180.0
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return (lon_w, lat_s, lon_e, lat_n)


# --------------------------------------------------------------------------- #
# Terrarium encode/decode. encode() must be the exact inverse of MapLibre's decode
# `(R*256 + G + B/256) - 32768`, or terrain shows as terraced/striped artefacts.
# --------------------------------------------------------------------------- #
def encode_terrarium_png(elevation: np.ndarray) -> bytes:
    """Encode a float32 elevation grid (metres) to a terrarium-encoded RGB PNG."""
    v = np.clip(
        elevation.astype(np.float64) + _TERRARIUM_OFFSET,
        0.0,
        65536.0 - (1.0 / 256.0),  # keep R in [0,255]; the top 1/256 m is unrepresentable anyway
    )
    vi = np.floor(v).astype(np.int64)
    r = (vi >> 8) & 0xFF
    g = vi & 0xFF
    b = np.floor((v - vi) * 256.0).astype(np.int64) & 0xFF
    rgb = np.dstack([r, g, b]).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def decode_terrarium(rgb: np.ndarray) -> np.ndarray:
    """Inverse of :func:`encode_terrarium_png`'s per-pixel encoding (metres). For tests."""
    r = rgb[..., 0].astype(np.float64)
    g = rgb[..., 1].astype(np.float64)
    b = rgb[..., 2].astype(np.float64)
    return (r * 256.0 + g + b / 256.0) - _TERRARIUM_OFFSET


class TerrainXyzService:
    """Renders/caches terrarium XYZ tiles from the LINZ provider's COGs, with a Terrarium fallback.

    A ``None`` return from :meth:`render_tile` means "I can't serve this tile" — the route turns that
    into a 307 redirect to AWS Terrarium so the map source stays hole-free.
    """

    def __init__(
        self,
        linz_provider,
        cache_dir: str,
        cache_size_gb: float,
        ttl_days: int,
        minzoom: int,
        maxzoom_dem: int,
        maxzoom_dsm: int,
    ):
        self.linz = linz_provider  # the "linz" DEMProvider instance, or None if not in the chain
        self.minzoom = minzoom
        self.maxzoom = {"dem": maxzoom_dem, "dsm": maxzoom_dsm}
        # 0 days => never expire (immutable per-survey LIDAR); else a long TTL so a resurvey is
        # eventually picked up despite the location-based key.
        self.expire = (ttl_days * 86400) if ttl_days > 0 else None
        # Dedicated cache instance: its own dir + LRU + size budget so tile churn never evicts the
        # simulation's expensive SDF cache (which shares SPLAT_CACHE_DIR), and vice-versa.
        self.cache = Cache(
            os.path.join(cache_dir, "xyz"),
            size_limit=int(cache_size_gb * 1024 * 1024 * 1024),
            eviction_policy="least-recently-used",
        )
        logger.info(
            "Terrain XYZ tiles ready (linz=%s, cache '%s/xyz' limit %.0f GB, ttl=%s, zoom %d..[dem %d,"
            " dsm %d]).",
            "on" if linz_provider is not None else "off",
            cache_dir, cache_size_gb, self.expire, minzoom, maxzoom_dem, maxzoom_dsm,
        )

    @classmethod
    def from_env(cls, linz_provider, env) -> "TerrainXyzService":
        return cls(
            linz_provider=linz_provider,
            cache_dir=env.get("SPLAT_CACHE_DIR", ".splat_tiles"),
            cache_size_gb=float(env.get("LINZ_TILE_CACHE_GB", "10")),
            ttl_days=int(env.get("LINZ_TILE_TTL_DAYS", "180")),
            minzoom=int(env.get("LINZ_TILE_MINZOOM", "11")),
            maxzoom_dem=int(env.get("LINZ_TILE_MAXZOOM_DEM", "15")),
            maxzoom_dsm=int(env.get("LINZ_TILE_MAXZOOM_DSM", "14")),
        )

    def config(self) -> dict:
        """The zoom band the frontend must mirror when building the raster-dem source."""
        return {
            "minzoom": self.minzoom,
            "maxzoom": {"dem": self.maxzoom["dem"], "dsm": self.maxzoom["dsm"]},
            "tiles": "/terrain/{source}/{z}/{x}/{y}.png",
            "available": self.linz is not None,
        }

    def render_tile(self, source: str, z: int, x: int, y: int) -> Optional[bytes]:
        """PNG bytes for the tile, or ``None`` to signal the route to redirect to Terrarium.

        Blocking (remote COG reads) — call from a threadpool so it can't stall the event loop.
        """
        maxz = self.maxzoom.get(source)
        if self.linz is None or maxz is None:
            return None
        # Zoom band: low zoom would fan out to hundreds of COGs for one tile (and LIDAR detail is
        # invisible there); above the cap MapLibre shouldn't even ask. Either way → Terrarium.
        if z < self.minzoom or z > maxz:
            return None

        wgs = tile_to_wgs84_bbox(z, x, y)
        if not self.linz.covers(*wgs):  # cheap NZ-bbox gate, no network
            return None

        key = f"{source}:{z}:{x}:{y}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached

        # Past here any failure degrades to None (→ Terrarium redirect), never raises, mirroring the
        # LINZ provider's "never break the chain" philosophy.
        try:
            product = "dsm_1m" if source == "dsm" else "dem_1m"
            cog_urls = self.linz.discover_cog_urls_for_bbox(wgs, product)
            if not cog_urls:
                return None
            png = self._render(z, x, y, cog_urls)
            if png is None:
                return None
            self.cache.set(key, png, expire=self.expire)
            return png
        except Exception as e:  # noqa: BLE001 — deliberate: degrade to Terrarium, don't 500.
            logger.warning("Terrain tile %s/%d/%d/%d failed, deferring to Terrarium: %s", source, z, x, y, e)
            return None

    def _render(self, z: int, x: int, y: int, cog_urls: List[str]) -> Optional[bytes]:
        """Warp the intersecting COGs into one 256x256 web-mercator tile and terrarium-encode it."""
        minx, miny, maxx, maxy = tile_to_mercator_bbox(z, x, y)
        dst_transform = from_bounds(minx, miny, maxx, maxy, TILE_SIZE, TILE_SIZE)

        elev = np.zeros((TILE_SIZE, TILE_SIZE), dtype=np.float32)  # uncovered stays 0 m (sea level)
        covered = np.zeros((TILE_SIZE, TILE_SIZE), dtype=bool)

        with rasterio.Env(**_GDAL_VSICURL_ENV):
            for url in cog_urls:
                with rasterio.open(url) as src:
                    # WarpedVRT onto the exact 256x256 tile grid. Critical for speed: because the
                    # output is much coarser than the 1 m source, GDAL reads from the COG's internal
                    # overviews (a tiny decimated window) instead of the full-res window — a plain
                    # reproject() would pull megapixels of 1 m data per tile. dtype float32 so the
                    # float _NODATA fits regardless of the source's integer type.
                    with WarpedVRT(
                        src,
                        src_nodata=src.nodata,
                        crs="EPSG:3857",
                        transform=dst_transform,
                        width=TILE_SIZE,
                        height=TILE_SIZE,
                        resampling=Resampling.bilinear,
                        nodata=_NODATA,
                        dtype="float32",
                    ) as vrt:
                        tmp = vrt.read(1)
                valid = (tmp > _NODATA + 1.0) & np.isfinite(tmp)
                take = valid & ~covered  # first COG to cover a pixel wins (tiles barely overlap)
                elev[take] = tmp[take]
                covered |= valid

        if not covered.any():
            return None  # within NZ bbox but no actual LIDAR here (e.g. an ocean edge tile)
        return encode_terrarium_png(elev)
