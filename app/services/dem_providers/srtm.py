"""
AWS SRTM provider — the global default terrain source.

Streams 1-arcsecond SRTM ``.hgt.gz`` tiles from the public ``elevation-tiles-prod`` AWS Open Data
bucket (anonymous access), optionally downsamples to 3-arcsecond, and converts to SPLAT! ``.sdf``
with srtm2sdf. This is the behaviour the app shipped with; the logic is unchanged, only relocated
out of ``Splat`` behind the provider contract. Bare-earth and global, so it ignores
``terrain_source`` and is normally placed last in the chain as the catch-all.
"""

import gzip
import io
import logging
import math
import os
import subprocess
import tempfile
from typing import Mapping, Optional

import boto3
import rasterio
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError
from diskcache import Cache
from rasterio.enums import Resampling
from rasterio.transform import Affine

from app.services.dem_providers.base import DEMProvider, TerrainTile
from app.services.dem_providers import register_provider

logger = logging.getLogger(__name__)


@register_provider
class SrtmProvider(DEMProvider):
    name = "srtm"

    def __init__(
        self,
        splat_path: str,
        cache_dir: str = ".splat_tiles",
        cache_size_gb: float = 1.0,
        bucket_name: str = "elevation-tiles-prod",
        bucket_prefix: str = "v2/skadi",
    ):
        self.srtm2sdf_binary = os.path.join(splat_path, "srtm2sdf")
        self.srtm2sdf_hd_binary = os.path.join(splat_path, "srtm2sdf-hd")
        for binary in (self.srtm2sdf_binary, self.srtm2sdf_hd_binary):
            if not os.path.isfile(binary) or not os.access(binary, os.X_OK):
                raise FileNotFoundError(f"srtm2sdf binary not found or not executable at '{binary}'")

        self.tile_cache = Cache(cache_dir, size_limit=int(cache_size_gb * 1024 * 1024 * 1024))
        self.s3 = boto3.client("s3", config=Config(signature_version=UNSIGNED))
        self.bucket_name = bucket_name
        self.bucket_prefix = bucket_prefix
        logger.info(
            "SRTM provider ready (cache '%s' limit %.1f GB, bucket %s/%s).",
            cache_dir, cache_size_gb, bucket_name, bucket_prefix,
        )

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "SrtmProvider":
        return cls(
            splat_path=env.get("SPLAT_PATH", "/app/splat"),
            cache_dir=env.get("SPLAT_CACHE_DIR", ".splat_tiles"),
            cache_size_gb=float(env.get("SPLAT_CACHE_SIZE_GB", "1.0")),
            bucket_name=env.get("SRTM_BUCKET_NAME", "elevation-tiles-prod"),
            bucket_prefix=env.get("SRTM_BUCKET_PREFIX", "v2/skadi"),
        )

    def try_get_sdf(self, tile: TerrainTile) -> Optional[bytes]:
        # The global catch-all: download the SRTM tile and convert it. Failures (e.g. an ocean
        # cell with no SRTM coverage) propagate as errors, matching the app's prior behaviour.
        hgt = self._download_terrain_tile(tile.hgt_name)
        return self._convert_hgt_to_sdf(hgt, tile.hgt_name, tile.sdf_filename, tile.high_resolution)

    def sample_elevation(self, lat: float, lon: float) -> Optional[float]:
        """Bare-earth ground elevation (metres above sea level) at ``(lat, lon)``.

        A cheap point lookup that reuses the cached ``.hgt.gz`` download but bypasses the SDF
        conversion pipeline — used for the radio-horizon link pre-filter. Returns ``None`` when the
        tile is unavailable (e.g. an ocean cell with no SRTM coverage) or the sampled pixel is an
        SRTM void, so callers can fall back to not filtering rather than assuming sea level.
        """
        lat_tile, lon_tile = math.floor(lat), math.floor(lon)
        ns = "N" if lat_tile >= 0 else "S"
        ew = "E" if lon_tile >= 0 else "W"
        tile_name = f"{ns}{abs(lat_tile):02d}{ew}{abs(lon_tile):03d}.hgt.gz"
        try:
            raw = gzip.decompress(self._download_terrain_tile(tile_name))
        except Exception as e:
            logger.warning("Elevation sample failed to fetch %s: %s", tile_name, e)
            return None

        with tempfile.TemporaryDirectory() as tmpdir:
            # rasterio's SRTMHGT driver derives the tile's georeferencing from the filename, so the
            # decompressed bytes must be written out under the original cell name before opening.
            hgt_path = os.path.join(tmpdir, tile_name.replace(".gz", ""))
            try:
                with open(hgt_path, "wb") as hgt_file:
                    hgt_file.write(raw)
                with rasterio.open(hgt_path) as src:
                    row, col = src.index(lon, lat)
                    value = float(src.read(1, window=((row, row + 1), (col, col + 1)))[0, 0])
                    nodata = src.nodata
            except Exception as e:
                logger.warning("Elevation sample failed to read %s: %s", tile_name, e)
                return None

        if (nodata is not None and value == nodata) or value <= -32768:  # SRTM void sentinel
            return None
        return value

    # ------------------------------------------------------------------ #
    # Tile download (S3, anonymous) + diskcache
    # ------------------------------------------------------------------ #
    def _download_terrain_tile(self, tile_name: str) -> bytes:
        """Download an SRTM ``.hgt.gz`` tile from S3, caching it locally. Falls back to the v1
        SRTM prefix when the v2 key is absent."""
        if tile_name in self.tile_cache:
            logger.info("Cache hit: %s found in the local cache.", tile_name)
            return self.tile_cache[tile_name]

        tile_dir_prefix = tile_name[:3]
        s3_key = f"{self.bucket_prefix}/{tile_dir_prefix}/{tile_name}"
        logger.info("Downloading %s from %s/%s...", tile_name, self.bucket_name, s3_key)
        try:
            obj = self.s3.get_object(Bucket=self.bucket_name, Key=s3_key)
            tile_data = obj["Body"].read()
            self.tile_cache[tile_name] = tile_data
            return tile_data
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                logger.info("Tile %s missing under %s, trying v1 SRTM prefix.", tile_name, self.bucket_prefix)
                s3_key = f"skadi/{tile_dir_prefix}/{tile_name}"
                obj = self.s3.get_object(Bucket=self.bucket_name, Key=s3_key)
                tile_data = obj["Body"].read()
                self.tile_cache[tile_name] = tile_data
                return tile_data
            logger.error("Failed to download %s from S3 due to ClientError: %s", tile_name, e)
            raise
        except Exception as e:
            logger.error("Failed to download %s from S3: %s", tile_name, e)
            raise

    # ------------------------------------------------------------------ #
    # HGT -> SDF conversion (srtm2sdf) + diskcache
    # ------------------------------------------------------------------ #
    def _convert_hgt_to_sdf(
        self, tile: bytes, tile_name: str, sdf_filename: str, high_resolution: bool
    ) -> bytes:
        """Decompress a ``.hgt.gz`` tile, optionally downsample to 3-arcsecond, and convert it to
        the SPLAT! ``.sdf`` named ``sdf_filename`` via srtm2sdf / srtm2sdf-hd."""
        if sdf_filename in self.tile_cache:
            logger.info("Cache hit: %s found in the local cache.", sdf_filename)
            return self.tile_cache[sdf_filename]

        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                hgt_path = os.path.join(tmpdir, tile_name.replace(".gz", ""))
                logger.info("Decompressing %s into %s.", tile_name, hgt_path)
                with gzip.GzipFile(fileobj=io.BytesIO(tile)) as gz_file:
                    with open(hgt_path, "wb") as hgt_file:
                        hgt_file.write(gz_file.read())

                if not high_resolution:
                    self._downsample_to_3arcsec(hgt_path)

                cmd = self.srtm2sdf_hd_binary if high_resolution else self.srtm2sdf_binary
                logger.info("Converting %s to %s using %s.", hgt_path, sdf_filename, cmd)
                result = subprocess.run(
                    [cmd, os.path.basename(tile_name.replace(".gz", ""))],
                    cwd=tmpdir,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                logger.debug("srtm2sdf output:\n%s", result.stderr)

                sdf_path = os.path.join(tmpdir, sdf_filename)
                if not os.path.exists(sdf_path):
                    raise RuntimeError(f"Failed to generate .sdf file: {sdf_path}")

                with open(sdf_path, "rb") as sdf_file:
                    sdf_data = sdf_file.read()
                self.tile_cache[sdf_filename] = sdf_data
                logger.info("Successfully converted and cached %s.", sdf_filename)
                return sdf_data
            except subprocess.CalledProcessError as e:
                logger.error("srtm2sdf failed for %s: %s\nstderr: %s", tile_name, e, e.stderr)
                raise RuntimeError(f"Subprocess error during conversion of {tile_name}: {e}")
            except Exception as e:
                logger.error("Error converting %s to %s: %s", tile_name, sdf_filename, e)
                raise RuntimeError(f"Conversion error for {tile_name}: {e}")

    @staticmethod
    def _downsample_to_3arcsec(hgt_path: str) -> None:
        """Resample a 1-arcsecond HGT in place to the 1201x1201 grid srtm2sdf expects for the
        standard-resolution (3-arcsecond) path."""
        logger.info("Downsampling %s to 3-arcsecond resolution.", hgt_path)
        with rasterio.open(hgt_path) as src:
            transform = src.transform * Affine.scale(3, 3)  # 3-arcsec is 3x coarser than 1-arcsec
            data = src.read(
                out_shape=(src.count, 1201, 1201),  # 3-arcsec SRTM tiles are always 1201x1201
                resampling=Resampling.average,
            )
            meta = src.meta.copy()
            meta.update({"transform": transform, "width": 1201, "height": 1201})
        with rasterio.open(hgt_path, "w", **meta) as dst:
            dst.write(data)
        logger.info("Successfully downsampled %s.", hgt_path)
