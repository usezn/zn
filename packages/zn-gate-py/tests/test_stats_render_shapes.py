import datetime
import json
import re

import pytest

from zn_gate import stats

TODAY = datetime.date(2026, 10, 14)
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
COUNTERS = {"checked": 1234, "blocked": 5, "warned": 2, "redacted": 7}


def write(tmp_path, days):
    (tmp_path / "stats.json").write_text(json.dumps({"version": 1, "days": days, "events": {}}), encoding="utf-8")


def busy_day(key="hook:codex", dets=None):
    return {key: dict(COUNTERS, detections=dets or {"AWS_KEY": 3})}


def check_shape(text):
    assert text.endswith("\n") and not text.endswith("\n\n")
    assert "\x1b" not in text and not ANSI.search(text)
    for line in text.split("\n")[:-1]:
        assert line == line.rstrip(), repr(line)
        assert "\r" not in line and "\t" not in line


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    return tmp_path


def test_zero_days_window_counts_nothing(home):
    write(home, {TODAY.isoformat(): busy_day()})
    s = stats.summary(days=0, now=TODAY)
    text = stats.render(s)
    check_shape(text)
    assert text.startswith("zn-gate on this machine, last 0 days:\n")
    assert "Nothing recorded yet" in text
    assert "events checked" not in text


def test_one_day_window_has_one_line_per_counter(home):
    write(home, {TODAY.isoformat(): busy_day(), "2026-10-13": busy_day()})
    text = stats.render(stats.summary(days=1, now=TODAY))
    check_shape(text)
    lines = text.splitlines()
    assert lines[0] == "zn-gate on this machine, last 1 day (counting since 2026-10-14):"
    for needle in ("1,234 events checked", "5 blocked", "7 secret values replaced", "2 warnings"):
        assert sum(l.startswith("  " + needle) for l in lines) == 1


def test_long_period_keeps_lines_clean(home):
    days = {(TODAY - datetime.timedelta(days=i)).isoformat(): busy_day() for i in range(400)}
    write(home, days)
    s = stats.summary(days=365, now=TODAY)
    text = stats.render(s)
    check_shape(text)
    assert "last 365 days (counting since 2025-10-15):" in text.splitlines()[0]
    assert "{:,} events checked".format(1234 * 365) in text
    assert sum("events checked" in l for l in text.splitlines()) == 1


def test_unicode_labels_stay_on_one_line_each(home):
    write(home, {TODAY.isoformat(): {
        "hook:agente-é": dict(COUNTERS, detections={"CLÉ_API": 4, "密钥": 2}),
        "mcp:代理": dict(COUNTERS, checked=1, detections={}),
    }})
    text = stats.render(stats.summary(days=7, now=TODAY))
    check_shape(text)
    lines = text.splitlines()
    assert any(l.startswith("    agente-é (agent hooks): 1,234 events") for l in lines)
    assert any(l.startswith("    代理 (MCP tools): 1 events") for l in lines)
    types = [l for l in lines if "Secret types found" in l]
    assert len(types) == 1 and "CLÉ_API 4" in types[0] and "密钥 2" in types[0]


def test_unknown_layer_is_shown_as_is_and_no_blank_padding(home):
    write(home, {TODAY.isoformat(): busy_day("custom:tool")})
    text = stats.render(stats.summary(days=3, now=TODAY))
    check_shape(text)
    assert "tool (custom): 1,234 events" in text
    assert "\n\n\n" not in text
