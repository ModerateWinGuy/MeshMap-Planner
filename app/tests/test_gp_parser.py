import os

from app.services.splat import Splat


def test_parses_two_column_metric_data(tmp_path):
    gp = tmp_path / "profile.gp"
    gp.write_text("0.000000\t188.500000\n1.250000\t201.300000\n2.500000\t245.000000\n")
    points = Splat._read_gp(str(gp))
    assert points == [[0.0, 188.5], [1.25, 201.3], [2.5, 245.0]]


def test_skips_blank_and_unparseable_lines(tmp_path):
    gp = tmp_path / "fresnel.gp"
    # Blank lines and a stray header line should be ignored, not raise.
    gp.write_text("\n# distance value\n0.0\t-12.5\nnot a row\n3.0  -8.0\n")
    points = Splat._read_gp(str(gp))
    assert points == [[0.0, -12.5], [3.0, -8.0]]


def test_missing_file_returns_empty_list(tmp_path):
    # SPLAT! omits e.g. fresnel.gp outside 20–20000 MHz; that must be [] not an error.
    points = Splat._read_gp(str(tmp_path / "does_not_exist.gp"))
    assert points == []
