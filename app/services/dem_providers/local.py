"""
Local SDF drop-in provider.

A manual override: drop correctly-named SPLAT! ``.sdf`` tiles into ``LOCAL_SDF_DIR`` and they take
precedence over any downstream source. Intended for hand-prepared or one-off terrain (e.g. a DEM
converted offline) for which no live provider exists. Read-only; files are served straight from
disk and never cached, so removing one cleanly reverts to the next provider.
"""

import logging
import os
from typing import Mapping, Optional

from app.services.dem_providers.base import DEMProvider, TerrainTile
from app.services.dem_providers import register_provider
from app.services.terrain_tiles import sdf_disk_aliases

logger = logging.getLogger(__name__)


@register_provider
class LocalSDFProvider(DEMProvider):
    name = "local"

    def __init__(self, sdf_dir: Optional[str]):
        # A configured-but-missing directory is treated as "no local tiles" rather than an error,
        # so the provider can sit in the default chain harmlessly until someone mounts tiles.
        if sdf_dir and os.path.isdir(sdf_dir):
            self.sdf_dir: Optional[str] = sdf_dir
            logger.info("Local SDF override enabled from '%s'.", sdf_dir)
        else:
            self.sdf_dir = None
            if sdf_dir:
                logger.warning("LOCAL_SDF_DIR '%s' is not a directory; local override disabled.", sdf_dir)

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "LocalSDFProvider":
        return cls(env.get("LOCAL_SDF_DIR"))

    def try_get_sdf(self, tile: TerrainTile) -> Optional[bytes]:
        if not self.sdf_dir:
            return None
        # Accept either the literal SPLAT! name (':' — created on Linux) or the Windows-safe form
        # ('_' — staged on Windows / baked into the image). SPLAT! always gets the colon name back.
        for name in sdf_disk_aliases(tile.sdf_filename):
            path = os.path.join(self.sdf_dir, name)
            if os.path.isfile(path):
                logger.info("Using local SDF '%s' from '%s'.", name, self.sdf_dir)
                with open(path, "rb") as sdf_file:
                    return sdf_file.read()
        return None
