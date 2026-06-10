"""Tile-naming and coverage helpers. These are stdlib-only and must stay byte-for-byte compatible
with the names srtm2sdf emits and SPLAT! reads, so the tests pin exact strings."""

from app.services.terrain_tiles import (
    calculate_p2p_tiles,
    calculate_required_tiles,
    hgt_to_sdf_filename,
    parse_hgt_cell,
)


def test_sdf_naming_western_hemisphere():
    # SPLAT! uses west-positive longitude internally; W120 -> 119:120.
    assert hgt_to_sdf_filename("N35W120.hgt.gz", high_resolution=False) == "35:36:119:120.sdf"
    assert hgt_to_sdf_filename("N35W120.hgt.gz", high_resolution=True) == "35:36:119:120-hd.sdf"


def test_sdf_naming_eastern_hemisphere():
    # NZ (Wellington) cell: E174 -> 360-175 .. 186 in SPLAT!'s west-positive convention.
    assert hgt_to_sdf_filename("S41E174.hgt.gz", high_resolution=True) == "-41:-40:185:186-hd.sdf"


def test_parse_hgt_cell_signed_sw_corner():
    # Plain signed degrees (north/east positive); this drives gdalwarp -te for non-SRTM sources.
    assert parse_hgt_cell("N35W120.hgt.gz") == (35, -120)
    assert parse_hgt_cell("S41E174.hgt.gz") == (-41, 174)
    assert parse_hgt_cell("N00E000.hgt.gz") == (0, 0)


def test_required_tiles_shape_and_names():
    tiles = calculate_required_tiles(-41.3, 174.8, 5000)
    assert len(tiles) == 1
    hgt, sdf, sdf_hd = tiles[0]
    assert hgt == "S42E174.hgt.gz"
    assert sdf == "-42:-41:185:186.sdf"
    assert sdf_hd.endswith("-hd.sdf")


def test_p2p_tiles_cover_both_endpoints():
    # Two points either side of a degree boundary should pull in both cells (plus the pad).
    tiles = calculate_p2p_tiles(-41.9, 174.5, -41.1, 175.2)
    names = {t[0] for t in tiles}
    assert "S42E174.hgt.gz" in names
    assert "S42E175.hgt.gz" in names
