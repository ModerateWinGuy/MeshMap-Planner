import pytest

from app.services.link_budget import (
    receiver_sensitivity_dbm,
    PRESET_TABLE,
    DEFAULT_PRESET,
)


def test_longfast_sensitivity_is_in_expected_range():
    # SF11 / 250 kHz / NF 6 dB -> -174 + 10log10(250000) + 6 - 17.5 ~= -131.5 dBm
    sensitivity = receiver_sensitivity_dbm("LongFast")
    assert -133.0 < sensitivity < -130.0


def test_faster_preset_is_less_sensitive_than_slower():
    # ShortFast (SF7) demodulates at a higher SNR than LongFast (SF11),
    # so its sensitivity is a higher (less negative) dBm value.
    assert receiver_sensitivity_dbm("ShortFast") > receiver_sensitivity_dbm("LongFast")


def test_all_presets_produce_negative_sensitivity():
    for name in PRESET_TABLE:
        assert receiver_sensitivity_dbm(name) < 0


def test_default_preset_is_known():
    assert DEFAULT_PRESET in PRESET_TABLE


def test_unknown_preset_raises():
    with pytest.raises(KeyError):
        receiver_sensitivity_dbm("NotARealPreset")
