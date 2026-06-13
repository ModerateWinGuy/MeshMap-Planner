"""SDF decode + nearest-neighbour sampling + sim-tile rendering for the "simulation terrain" map.

The decoder must reproduce exactly the grid SPLAT! reads, so orientation is pinned two ways: a
hermetic synthetic SDF (every post round-trips to its lat/lon), and — when the committed Wellington
fixtures are present — a real cell where Kapiti Island's ~520 m peak must land at its true position.
Skipped if the geo deps aren't installed locally (they are in the Docker image where the suite runs).
"""

import io
import os

import pytest

pytest.importorskip("numpy")
pytest.importorskip("PIL")
pytest.importorskip("rasterio")  # terrain_tiles_xyz (imported by terrain_sim_tiles) needs it

import math  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app.services.terrain_sim_tiles import TerrainSimService, decode_sdf, sample_grid  # noqa: E402
from app.services.terrain_tiles import sdf_disk_aliases  # noqa: E402
from app.services.terrain_tiles_xyz import decode_terrarium  # noqa: E402

_FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "local_sdf")
_KAPITI_SDF = os.path.join(_FIXTURE_DIR, "-41_-40_185_186-hd.sdf")  # std lon 174-175, lat -41..-40


def _make_sdf(ippd: int, values) -> bytes:
    """A minimal valid SDF: 4 header lines then ippd² elevations (one per line), as srtm2sdf writes."""
    header = b"186\n-41\n185\n-40\n"
    body = b"\n".join(str(int(v)).encode() for v in values) + b"\n"
    assert len(values) == ippd * ippd
    return header + body


def test_decode_sdf_shape_and_square_check():
    grid = decode_sdf(_make_sdf(4, range(16)))
    assert grid.shape == (4, 4)
    assert grid.dtype == np.int16
    # Row-major: g[a][b] == stream[a*ippd + b].
    assert np.array_equal(grid.ravel(), np.arange(16))
    with pytest.raises(ValueError):
        decode_sdf(b"186\n-41\n185\n")  # missing 4th header line
    with pytest.raises(ValueError):
        decode_sdf(b"186\n-41\n185\n-40\n1\n2\n3\n")  # 3 values, not square


def test_sample_grid_orientation_every_post():
    # Each post (a,b) is centred at lat = cell_lat + a/ippd, lon = cell_lon + (ippd-1-b)/ippd:
    # a runs south->north, b runs east->west from the SW corner. Sampling those centres must return
    # exactly that post's value, for all 16 posts — pinning both axes.
    ippd, cell_lat, cell_lon = 4, -41, 174
    grid = decode_sdf(_make_sdf(ippd, range(16)))
    for a in range(ippd):
        for b in range(ippd):
            lat = cell_lat + a / ippd
            lon = cell_lon + (ippd - 1 - b) / ippd
            got = sample_grid(grid, cell_lat, cell_lon, np.array([lat]), np.array([lon]))
            assert got[0] == grid[a, b], (a, b, got[0])


def test_sample_grid_clamps_outside_cell():
    grid = decode_sdf(_make_sdf(4, range(16)))
    # Far outside the cell clamps to an edge index rather than erroring.
    got = sample_grid(grid, -41, 174, np.array([-50.0, 50.0]), np.array([100.0, 200.0]))
    assert got.shape == (2,)


@pytest.mark.skipif(not os.path.isfile(_KAPITI_SDF), reason="local_sdf Wellington fixture not present")
def test_real_cell_kapiti_peak_orientation():
    grid = decode_sdf(open(_KAPITI_SDF, "rb").read())
    assert grid.shape == (3600, 3600)
    # Cell is mostly Tasman Sea, so the mean is low and the max is Kapiti Island (~520 m).
    assert grid.mean() < 50
    assert 480 <= grid.max() <= 560
    # The peak must sit near Kapiti's true position (-40.86, 174.93), not its mirror.
    a, b = np.unravel_index(np.argmax(grid), grid.shape)
    peak_lat = -41 + a / 3600
    peak_lon = 174 + (3599 - b) / 3600
    assert peak_lat == pytest.approx(-40.86, abs=0.05)
    assert peak_lon == pytest.approx(174.93, abs=0.05)


class _StubSplat:
    """Stands in for the Splat service: serves SDF bytes straight from the local fixture dir."""

    def __init__(self, sdf_dir):
        self.sdf_dir = sdf_dir

    def get_sdf_bytes(self, tile):
        for name in sdf_disk_aliases(tile.sdf_filename):
            path = os.path.join(self.sdf_dir, name)
            if os.path.isfile(path):
                return open(path, "rb").read()
        return None


def _tile_xyz(z, lat, lon):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return z, x, y


@pytest.mark.skipif(not os.path.isfile(_KAPITI_SDF), reason="local_sdf Wellington fixture not present")
def test_render_tile_over_land_is_blocky(tmp_path):
    svc = TerrainSimService(_StubSplat(_FIXTURE_DIR), cache_dir=str(tmp_path), cache_size_gb=0.05, ttl_days=0)
    z, x, y = _tile_xyz(13, -40.86, 174.93)  # a tile over Kapiti Island, inside the fixture cell
    png = svc.render_tile("srtm", "hd", z, x, y)
    assert png is not None
    elev = decode_terrarium(np.array(Image.open(io.BytesIO(png))))
    assert elev.shape == (256, 256)
    assert elev.max() > 50  # sampled real land, not all sea-level zero


def test_render_tile_no_data_returns_none(tmp_path):
    # A stub that never serves an SDF (e.g. open ocean) → None, so the route falls back to Terrarium.
    class _Empty:
        def get_sdf_bytes(self, tile):
            return None

    svc = TerrainSimService(_Empty(), cache_dir=str(tmp_path), cache_size_gb=0.05, ttl_days=0)
    assert svc.render_tile("srtm", "sd", 10, 0, 0) is None
    assert svc.render_tile("bogus", "hd", 13, 1, 1) is None  # bad source
    assert svc.render_tile("srtm", "xx", 13, 1, 1) is None   # bad res
