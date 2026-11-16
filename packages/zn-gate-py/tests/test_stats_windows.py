"""Window sizes, damaged input and very large counters for stats.summary and stats.render (temporary HOME)."""

import datetime
import json

import pytest

from zn_gate import stats

TODAY = datetime.date(2026, 10, 14)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.delenv("ZN_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    return tmp_path


def write_days(home, days):
    d = home / ".zn"
    d.mkdir(exist_ok=True)
    (d / "stats.json").write_text(json.dumps({"version": 1, "days": days, "events": {}}))


def one(n):
    return {"hook:a": {"checked": n, "blocked": 0, "warned": 0, "redacted": 0}}


def offset(n):
    return (TODAY - datetime.timedelta(days=n)).isoformat()


@pytest.mark.parametrize("days,expected", [(1, 1), (7, 1 + 10), (30, 1 + 10 + 100), (0, 0)])
def test_window_sizes(home, days, expected):
    # today, 6 days ago (last day of a 7-day window), 29 days ago (last day of a 30-day window)
    write_days(home, {offset(0): one(1), offset(6): one(10), offset(29): one(100), offset(30): one(1000)})
    s = stats.summary(days=days, now=TODAY)
    assert s["total"]["checked"] == expected
    assert s["days"] == days


def test_day_before_window_is_excluded(home):
    write_days(home, {offset(1): one(5)})
    assert stats.summary(days=1, now=TODAY)["since"] is None
    assert stats.summary(days=2, now=TODAY)["since"] == offset(1)


def test_zero_days_renders_empty_with_plural_wording(home):
    write_days(home, {offset(0): one(5)})
    text = stats.render(stats.summary(days=0, now=TODAY))
    assert text.startswith("zn-gate on this machine, last 0 days:")
    assert "Nothing recorded yet" in text


def test_missing_file_renders_for_each_window(home):
    for days in (1, 7, 30, 0):
        text = stats.render(stats.summary(days=days, now=TODAY))
        assert "Nothing recorded yet" in text
        assert "counting since" not in text


def test_file_that_is_not_text_reads_as_empty(home):
    (home / ".zn").mkdir()
    (home / ".zn" / "stats.json").write_bytes(b"\xff\xfe\x00\x80")
    assert stats.summary(now=TODAY)["total"]["checked"] == 0


def test_directory_in_place_of_file_reads_as_empty(home):
    (home / ".zn" / "stats.json").mkdir(parents=True)
    assert stats.summary(now=TODAY)["since"] is None


def test_very_large_counter_is_summed_and_grouped(home):
    big = 10 ** 20
    write_days(home, {offset(0): one(big), offset(1): one(big)})
    s = stats.summary(days=7, now=TODAY)
    assert s["total"]["checked"] == 2 * big
    text = stats.render(s)
    assert "200,000,000,000,000,000,000 events checked" in text
    assert "last 7 days (counting since %s):" % offset(1) in text
