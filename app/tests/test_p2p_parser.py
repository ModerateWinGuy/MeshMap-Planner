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
