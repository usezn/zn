"""ZN_STRICT and ZN_BLOCK_TRUNCATED turn on only with "1": any other value leaves the hardening off, and
that is said once in the log instead of silently."""

import logging

from zn_gate import rules


def _warnings(caplog):
    return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING and r.name == "zn_gate"]


def test_other_values_warn_once_and_stay_off(caplog, monkeypatch):
    caplog.set_level(logging.WARNING, logger="zn_gate")
    rules._ENV_FLAG_WARNED.clear()
    for name in ("ZN_STRICT", "ZN_BLOCK_TRUNCATED"):
        monkeypatch.setenv(name, "true")
        assert rules.env_flag(name) is False
        assert rules.env_flag(name) is False
    msgs = _warnings(caplog)
    assert sum("ZN_STRICT is set to 'true', but only ZN_STRICT=1 turns it on" in m for m in msgs) == 1, msgs
    assert sum("ZN_BLOCK_TRUNCATED is set to 'true'" in m for m in msgs) == 1, msgs


def test_one_turns_it_on_and_unset_or_zero_is_quiet(caplog, monkeypatch):
    caplog.set_level(logging.WARNING, logger="zn_gate")
    rules._ENV_FLAG_WARNED.clear()
    monkeypatch.setenv("ZN_STRICT", "1")
    assert rules.env_flag("ZN_STRICT") is True
    for value in ("0", ""):
        monkeypatch.setenv("ZN_STRICT", value)
        assert rules.env_flag("ZN_STRICT") is False
    monkeypatch.delenv("ZN_STRICT")
    assert rules.env_flag("ZN_STRICT") is False
    assert _warnings(caplog) == []


def test_truncated_flags_warn_with_accepted_values(monkeypatch, caplog):
    import logging
    from zn_gate import rules
    rules._ENV_FLAG_WARNED.clear()
    for name in ("ZN_BLOCK_TRUNCATED", "ZN_ALLOW_TRUNCATED"):
        monkeypatch.setenv(name, "yes")
    with caplog.at_level(logging.WARNING, logger="zn_gate"):
        assert rules.env_flag("ZN_BLOCK_TRUNCATED") is False
        assert rules.truncated_blocks() is True  # ZN_ALLOW_TRUNCATED=yes does not opt out
    msgs = [r.getMessage() for r in caplog.records]
    for name in ("ZN_BLOCK_TRUNCATED", "ZN_ALLOW_TRUNCATED"):
        assert any(name in m and "accepted values" in m for m in msgs), msgs
