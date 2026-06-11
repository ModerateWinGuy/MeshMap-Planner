import os

from app.services.splat import Splat

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "tx-to-rx.txt")


def _fixture_text() -> str:
    with open(FIXTURE_PATH, "r", encoding="utf-8") as fixture:
        return fixture.read()


def test_parses_core_fields_from_fixture():
    metrics = Splat._parse_p2p_report(_fixture_text())
    assert metrics["free_space_db"] == 113.45
    assert metrics["path_loss_db"] == 134.67
    assert metrics["rx_power_dbm"] == -98.70
    assert metrics["fresnel_pct"] == 87.5


def test_path_loss_not_confused_with_free_space():
    # The ITM/Longley-Rice path loss must be distinct from the free-space figure.
    metrics = Splat._parse_p2p_report(_fixture_text())
    assert metrics["path_loss_db"] != metrics["free_space_db"]


def test_missing_fields_degrade_to_none():
    metrics = Splat._parse_p2p_report("this report contains nothing useful")
    assert metrics["free_space_db"] is None
    assert metrics["path_loss_db"] is None
    assert metrics["rx_power_dbm"] is None
    assert metrics["fresnel_pct"] is None


def test_longley_rice_label_variant_is_parsed():
    text = "Longley-Rice path loss: 150.20 dB\n"
    metrics = Splat._parse_p2p_report(text)
    assert metrics["path_loss_db"] == 150.20


def test_fresnel_not_confused_with_fraction_lines():
    # Regression: the parser must not grab the "Fraction of Time/Situations: NN%" lines that
    # precede the Fresnel sentence. A clear path reports 100%, not the 95% time fraction.
    text = (
        "Fraction of Situations: 95.0%\n"
        "Fraction of Time: 95.0%\n\n"
        "The first Fresnel zone is clear.\n"
    )
    assert Splat._parse_p2p_report(text)["fresnel_pct"] == 100.0


def test_fresnel_partial_clearance_is_parsed():
    text = "Fraction of Time: 95.0%\n60% of the first Fresnel zone is clear.\n"
    assert Splat._parse_p2p_report(text)["fresnel_pct"] == 60.0


def test_fresnel_obstructed_path_is_none():
    # When obstructed, SPLAT! only says how high to raise the antenna — no percentage.
    text = (
        "Fraction of Time: 95.0%\n"
        "Antenna at rx must be raised to at least 12.00 meters AGL\n"
        "to clear the first Fresnel zone.\n"
    )
    assert Splat._parse_p2p_report(text)["fresnel_pct"] is None
