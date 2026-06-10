"""
DEM-provider registry and assembly.

Providers self-register by name; the active set and their precedence come entirely from the
``DEM_PROVIDERS`` config string (e.g. ``"local,linz,srtm"``). ``main.py`` resolves that string to
an ordered list of provider instances via :func:`build_providers` and hands it to ``Splat`` — it
never names a concrete provider class.

To add a source: create ``<name>.py`` with a ``DEMProvider`` subclass decorated
``@register_provider``, import it below so it registers, and add its name to ``DEM_PROVIDERS``.
"""

import logging
from typing import List, Mapping, Type

from app.services.dem_providers.base import DEMProvider, TerrainTile

logger = logging.getLogger(__name__)

_REGISTRY: "dict[str, Type[DEMProvider]]" = {}


def register_provider(cls: "Type[DEMProvider]") -> "Type[DEMProvider]":
    """Class decorator: register a concrete provider under its ``name``."""
    if not getattr(cls, "name", ""):
        raise ValueError(f"{cls.__name__} must set a non-empty 'name' to be registered.")
    if cls.name in _REGISTRY and _REGISTRY[cls.name] is not cls:
        raise ValueError(f"Duplicate DEM provider name {cls.name!r}.")
    _REGISTRY[cls.name] = cls
    return cls


def registered_names() -> "List[str]":
    """All currently registered provider names (for diagnostics/tests)."""
    return sorted(_REGISTRY)


def build_providers(order: "List[str]", env: Mapping[str, str]) -> "List[DEMProvider]":
    """Resolve an ordered list of provider names to instances via the registry.

    Order is precedence. An unknown name raises immediately (fail fast at startup) rather than
    silently dropping a source the operator asked for.
    """
    providers: "List[DEMProvider]" = []
    for name in order:
        if name not in _REGISTRY:
            raise ValueError(
                f"Unknown DEM provider {name!r}. Registered: {registered_names()}. "
                f"Check the DEM_PROVIDERS setting."
            )
        providers.append(_REGISTRY[name].from_env(env))
    logger.info("DEM provider chain (in precedence order): %s", order)
    return providers


# Import concrete providers so their @register_provider decorators run. Kept at the bottom to
# avoid import-order surprises; these modules import only `base` and `terrain_tiles`, never
# `splat`, so there is no cycle.
from app.services.dem_providers import local, linz, srtm  # noqa: E402,F401

__all__ = [
    "DEMProvider",
    "TerrainTile",
    "register_provider",
    "registered_names",
    "build_providers",
]
