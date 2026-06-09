import os

import numpy as np
import pytest
from pydantic import ValidationError
from rasterio.transform import from_origin

from app.services.splat import Splat
from app.models.MatrixRequest import MatrixNode
from app.models.RelayRequest import RelayRequest

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "sample.ano")


def _ano_text() -> str:
    with open(FIXTURE_PATH, "r", encoding="utf-8") as fixture:
        return fixture.read()


# --------------------------------------------------------------------------- #
# -ano parsing
# --------------------------------------------------------------------------- #

def test_parse_ano_skips_headers_and_converts_longitude():
    points = Splat._parse_splat_ano(_ano_text())
    assert points.shape == (3, 3)  # three data rows, two header lines skipped
    lat, lon, dbm = points[0]
    assert lat == 51.1
    assert lon == pytest.approx(-114.1)  # SPLAT west-positive 114.1 -> standard -114.1
    assert dbm == -120.5


def test_parse_ano_strips_trailing_marker():
    points = Splat._parse_splat_ano(_ano_text())
    # The second row ends with " *"; its dBm must still parse cleanly.
    assert points[1][2] == -118.25


def test_parse_ano_empty_returns_zero_by_three():
    points = Splat._parse_splat_ano("; only a header\n")
    assert points.shape == (0, 3)


# --------------------------------------------------------------------------- #
# binning
# --------------------------------------------------------------------------- #

def test_bin_points_keeps_strongest_and_computes_margin():
    # Two points fall in the same cell; the stronger dBm must win.
    cell = 0.01
    points = np.array([
        [51.005, -114.005, -120.0],
        [51.006, -114.004, -110.0],  # same 0.01-degree cell, stronger
        [51.025, -114.005, -130.0],  # different cell
    ])
    binned = Splat._bin_points_to_margin(points, cell, sensitivity=-130.0, gain=2.0)
    # cell of the first two: floor(51.00x/0.01)=5100, floor(-114.00x/0.01)=-11401
    key = (5100, -11401)
    assert key in binned
    margin, dbm = binned[key]
    assert dbm == -110.0
    assert margin == pytest.approx(-110.0 + 2.0 - (-130.0))  # 22.0
    assert len(binned) == 2


# --------------------------------------------------------------------------- #
# connected components + bands
# --------------------------------------------------------------------------- #

def test_label_components_counts_two_blobs():
    mask = np.zeros((5, 7), dtype=bool)
    mask[0:2, 0:2] = True   # blob 1
    mask[3:5, 5:7] = True   # blob 2 (disconnected)
    labels, count = Splat._label_components(mask)
    assert count == 2
    assert set(np.unique(labels[mask])) == {0, 1}
    assert (labels[~mask] == -1).all()


def test_margin_band_and_label():
    edges = [0.0, 10.0, 20.0]
    assert Splat._margin_band(5.0, edges) == 0
    assert Splat._margin_band(15.0, edges) == 1
    assert Splat._margin_band(25.0, edges) == 2
    assert Splat._band_label(2, edges) == ">20 dB"
    assert Splat._band_label(0, edges).startswith("0")


# --------------------------------------------------------------------------- #
# islands -> polygons, and point ranking
# --------------------------------------------------------------------------- #

def _two_blob_grid():
    grid = np.full((5, 7), np.nan)
    grid[0:2, 0:2] = [[5.0, 6.0], [7.0, 8.0]]      # weak island, peak 8
    grid[3:5, 5:7] = [[22.0, 21.0], [20.0, 25.0]]  # strong island, peak 25
    transform = from_origin(-114.1, 51.2, 0.01, 0.01)
    return grid, transform


def test_island_polygons_emits_one_feature_per_island_sorted():
    grid, transform = _two_blob_grid()
    features, labels = Splat._island_polygons(grid, transform, [0.0, 10.0, 20.0], 0.01)
    assert len(features) == 2
    # Strongest island first.
    assert features[0]["properties"]["peak_margin"] == 25.0
    assert features[0]["properties"]["band"] == 2
    assert features[1]["properties"]["peak_margin"] == 8.0
    assert features[1]["properties"]["band"] == 0
    for f in features:
        assert f["geometry"]["type"] in ("Polygon", "MultiPolygon")
        assert f["properties"]["area_km2"] > 0
    assert int(labels.max()) == 1  # two islands -> ids 0 and 1


def test_rank_points_best_of_each_island_first():
    grid, transform = _two_blob_grid()
    _, labels = Splat._island_polygons(grid, transform, [0.0, 10.0, 20.0], 0.01)
    points = Splat._rank_points(grid, grid, grid + 1.0, labels, transform, top_n=2)
    assert len(points) == 2
    # One point per island, distinct islands, highest-margin island first.
    assert points[0]["properties"]["min_margin"] == 25.0
    assert points[1]["properties"]["min_margin"] == 8.0
    assert points[0]["properties"]["island_id"] != points[1]["properties"]["island_id"]
    # margin_b was grid+1 at the chosen cell.
    assert points[0]["properties"]["margin_b"] == 26.0


# --------------------------------------------------------------------------- #
# request validation
# --------------------------------------------------------------------------- #

def _node(node_id: str) -> MatrixNode:
    return MatrixNode(id=node_id, lat=51.0, lon=-114.0, height=10.0, tx_power=27.0,
                      tx_gain=2.0, rx_gain=2.0, frequency_mhz=905.0)


def test_relay_request_requires_sensitivity_basis():
    with pytest.raises(ValidationError):
        RelayRequest(node_a=_node("a"), node_b=_node("b"))  # neither preset nor sensitivity


def test_relay_request_accepts_preset():
    req = RelayRequest(node_a=_node("a"), node_b=_node("b"), lora_preset="LongFast")
    assert req.search_radius_m == 30000.0
    assert req.band_edges_db == [0.0, 10.0, 20.0]


def test_relay_request_rejects_oversize_radius():
    with pytest.raises(ValidationError):
        RelayRequest(node_a=_node("a"), node_b=_node("b"), lora_preset="LongFast",
                     search_radius_m=200000.0)


def test_relay_request_rejects_descending_bands():
    with pytest.raises(ValidationError):
        RelayRequest(node_a=_node("a"), node_b=_node("b"), lora_preset="LongFast",
                     band_edges_db=[20.0, 10.0, 0.0])
