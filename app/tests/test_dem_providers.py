"""DEM-provider registry, provisioning precedence, and coverage-gate behaviour.

These exercise the pluggable-terrain machinery. The provider package pulls in the geospatial
stack (boto3/rasterio/diskcache), so the suite skips cleanly where those aren't installed and runs
in CI / the container image where they are.
"""

import os
import tempfile

import pytest

pytest.importorskip("boto3")
pytest.importorskip("rasterio")
pytest.importorskip("diskcache")

from app.services.dem_providers import (  # noqa: E402
    DEMProvider,
    TerrainTile,
    build_providers,
    register_provider,
    registered_names,
)
from app.services.dem_providers.local import LocalSDFProvider  # noqa: E402
from app.services.dem_providers.linz import LinzProvider  # noqa: E402


def _tile(sdf="-42:-41:185:186.sdf", hd=False, source="dem", lat=-42, lon=174):
    return TerrainTile(
        lat=lat, lon=lon, sdf_filename=sdf, hgt_name="S42E174.hgt.gz",
        high_resolution=hd, terrain_source=source,
    )


# --------------------------------------------------------------------------- #
# Extensibility: the interface goal — a new source is registered + selected with
# no change to the core.
# --------------------------------------------------------------------------- #
def test_register_and_build_resolves_order():
    @register_provider
    class _DummyProvider(DEMProvider):
        name = "dummy_test"

        @classmethod
        def from_env(cls, env):
            return cls()

        def try_get_sdf(self, tile):
            return b"DUMMY"

    assert "dummy_test" in registered_names()
    chain = build_providers(["dummy_test", "srtm"], os.environ)
    assert [p.name for p in chain] == ["dummy_test", "srtm"]
    assert chain[0].try_get_sdf(_tile()) == b"DUMMY"


def test_build_providers_unknown_name_fails_fast():
    with pytest.raises(ValueError, match="Unknown DEM provider"):
        build_providers(["does_not_exist"], os.environ)


def test_register_requires_name():
    with pytest.raises(ValueError, match="non-empty 'name'"):
        @register_provider
        class _Nameless(DEMProvider):
            @classmethod
            def from_env(cls, env):
                return cls()

            def try_get_sdf(self, tile):
                return None


# --------------------------------------------------------------------------- #
# Provisioning precedence: first provider to return bytes wins; none -> error.
# --------------------------------------------------------------------------- #
class _Recorder(DEMProvider):
    """Test double returning a fixed result and recording whether it was consulted."""

    def __init__(self, name, result):
        self.name = name
        self.result = result
        self.calls = 0

    @classmethod
    def from_env(cls, env):  # pragma: no cover - not used in these tests
        return cls("rec", None)

    def try_get_sdf(self, tile):
        self.calls += 1
        return self.result


def _new_splat_with(providers):
    from app.services.splat import Splat  # imported lazily: pulls the full geospatial stack
    splat = Splat.__new__(Splat)  # bypass __init__ (binary checks) — we only test the helper
    splat.dem_providers = providers
    return splat


def test_provision_uses_first_non_none_and_stops():
    first = _Recorder("first", b"FIRST_SDF")
    second = _Recorder("second", b"SECOND_SDF")
    splat = _new_splat_with([first, second])
    tiles = [("S42E174.hgt.gz", "-42:-41:185:186.sdf", "-42:-41:185:186-hd.sdf")]
    with tempfile.TemporaryDirectory() as tmp:
        splat._provision_sdf_tiles(tmp, tiles, high_resolution=False, terrain_source="dem")
        with open(os.path.join(tmp, "-42:-41:185:186.sdf"), "rb") as f:
            assert f.read() == b"FIRST_SDF"
    assert first.calls == 1
    assert second.calls == 0  # precedence: second never consulted


def test_provision_falls_through_to_next_provider():
    first = _Recorder("first", None)
    second = _Recorder("second", b"SECOND_SDF")
    splat = _new_splat_with([first, second])
    tiles = [("S42E174.hgt.gz", "-42:-41:185:186.sdf", "-42:-41:185:186-hd.sdf")]
    with tempfile.TemporaryDirectory() as tmp:
        splat._provision_sdf_tiles(tmp, tiles, high_resolution=True, terrain_source="dem")
        # high_resolution -> the -hd name is written
        with open(os.path.join(tmp, "-42:-41:185:186-hd.sdf"), "rb") as f:
            assert f.read() == b"SECOND_SDF"
    assert first.calls == 1 and second.calls == 1


def test_provision_raises_when_no_provider_supplies():
    splat = _new_splat_with([_Recorder("a", None), _Recorder("b", None)])
    tiles = [("S42E174.hgt.gz", "-42:-41:185:186.sdf", "-42:-41:185:186-hd.sdf")]
    with tempfile.TemporaryDirectory() as tmp:
        with pytest.raises(RuntimeError, match="No DEM provider"):
            splat._provision_sdf_tiles(tmp, tiles, high_resolution=False, terrain_source="dem")


# --------------------------------------------------------------------------- #
# LocalSDFProvider: drop-in override.
# --------------------------------------------------------------------------- #
def test_local_provider_serves_dropped_file_else_none():
    with tempfile.TemporaryDirectory() as tmp:
        provider = LocalSDFProvider(tmp)
        tile = _tile()
        assert provider.try_get_sdf(tile) is None  # nothing dropped yet
        with open(os.path.join(tmp, tile.sdf_filename), "wb") as f:
            f.write(b"LOCAL_SDF")
        assert provider.try_get_sdf(tile) == b"LOCAL_SDF"


def test_local_provider_missing_dir_is_inert():
    provider = LocalSDFProvider("/no/such/dir")
    assert provider.try_get_sdf(_tile()) is None


def test_local_provider_accepts_windows_safe_name():
    # Tiles staged on Windows replace ':' with '_'; the provider must still find them.
    with tempfile.TemporaryDirectory() as tmp:
        provider = LocalSDFProvider(tmp)
        tile = _tile(sdf="-42:-41:185:186-hd.sdf")
        with open(os.path.join(tmp, "-42_-41_185_186-hd.sdf"), "wb") as f:
            f.write(b"WIN_SAFE_SDF")
        assert provider.try_get_sdf(tile) == b"WIN_SAFE_SDF"


# --------------------------------------------------------------------------- #
# LINZ coverage gate: cells outside NZ defer without any network I/O.
# --------------------------------------------------------------------------- #
def test_linz_defers_outside_nz_without_network():
    with tempfile.TemporaryDirectory() as cache_dir:
        provider = LinzProvider(splat_path="/app/splat", cache_dir=cache_dir)
        # A California cell (N35W120) must return None at the gate, before any catalog fetch.
        us_tile = TerrainTile(
            lat=35, lon=-120, sdf_filename="35:36:119:120.sdf", hgt_name="N35W120.hgt.gz",
            high_resolution=False, terrain_source="dem",
        )
        assert provider.try_get_sdf(us_tile) is None


def test_linz_cell_intersects_nz():
    # Wellington cell intersects the default NZ bbox; California does not.
    assert LinzProvider._cell_intersects(-42, 174, (166.0, -47.5, 179.5, -34.0)) is True
    assert LinzProvider._cell_intersects(35, -120, (166.0, -47.5, 179.5, -34.0)) is False
