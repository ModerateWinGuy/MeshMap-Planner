"""Terrarium encoding + XYZ tile geometry for the 3D-map terrain endpoint.

The encode must be the exact inverse of MapLibre's terrarium decode
``(R*256 + G + B/256) - 32768`` or terrain renders with terraced/striped artefacts, so the
round-trip error is pinned below the format's 1/256 m quantisation. Skipped if the geo deps aren't
installed locally (they are in the Docker image where the suite runs)."""

import io

import pytest

# terrain_tiles_xyz imports numpy/PIL/rasterio at module load; skip cleanly if any are absent.
pytest.importorskip("numpy")
pytest.importorskip("PIL")
pytest.importorskip("rasterio")

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app.services.terrain_tiles_xyz import (  # noqa: E402
    TILE_SIZE,
    decode_terrarium,
    encode_terrarium_png,
    tile_to_mercator_bbox,
    tile_to_wgs84_bbox,
    _MERC_ORIGIN,
)

_QUANTUM = 1.0 / 256.0  # terrarium vertical step


def _roundtrip(elevation: np.ndarray) -> np.ndarray:
    png = encode_terrarium_png(elevation)
    rgb = np.array(Image.open(io.BytesIO(png)))
    assert rgb.shape == (elevation.shape[0], elevation.shape[1], 3)
    return decode_terrarium(rgb)


def test_terrarium_roundtrip_submeter():
    # A spread of real-world elevations: below sea level, fractional, and a high peak.
    elevation = np.array(
        [[-500.0, -10.5, 0.0, 0.5], [1.25, 100.0, 1234.56, 8848.0]], dtype=np.float32
    )
    decoded = _roundtrip(elevation)
    err = decoded - elevation.astype(np.float64)
    # Encoding truncates the fraction, so decoded is never above the input and never off by ≥1 step.
    assert np.all(err <= 1e-6)
    assert np.all(err > -(_QUANTUM + 1e-6))


def test_terrarium_roundtrip_dense_range():
    # Sweep a continuous range to catch any byte-boundary (R/G carry) error.
    elevation = np.linspace(-400.0, 4000.0, num=TILE_SIZE * TILE_SIZE, dtype=np.float32).reshape(
        TILE_SIZE, TILE_SIZE
    )
    decoded = _roundtrip(elevation)
    assert np.max(np.abs(decoded - elevation.astype(np.float64))) < _QUANTUM + 1e-6


def test_mercator_bbox_world_at_z0():
    minx, miny, maxx, maxy = tile_to_mercator_bbox(0, 0, 0)
    assert minx == pytest.approx(-_MERC_ORIGIN)
    assert maxx == pytest.approx(_MERC_ORIGIN)
    assert miny == pytest.approx(-_MERC_ORIGIN)
    assert maxy == pytest.approx(_MERC_ORIGIN)


def test_wgs84_bbox_world_at_z0():
    w, s, e, n = tile_to_wgs84_bbox(0, 0, 0)
    assert (w, e) == pytest.approx((-180.0, 180.0))
    # Web-mercator clips at ±85.0511°.
    assert n == pytest.approx(85.0511, abs=1e-3)
    assert s == pytest.approx(-85.0511, abs=1e-3)


def test_wgs84_bbox_over_wellington():
    # A z12 tile covering Wellington (~ -41.29, 174.78) must land inside NZ with w<e, s<n.
    z, lat, lon = 12, -41.29, 174.78
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    import math
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    w, s, e, nth = tile_to_wgs84_bbox(z, x, y)
    assert w < e and s < nth
    assert w <= lon <= e
    assert s <= lat <= nth
    # Comfortably within the LINZ NZ bbox (166, -47.5, 179.5, -34).
    assert 166.0 <= w and e <= 179.5
    assert -47.5 <= s and nth <= -34.0
