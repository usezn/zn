"""Stats summary with a missing day, a day with one kind of event and days stored in a different order."""

import datetime
import json

from zn_gate import stats

TODAY = datetime.date(2026, 10, 14)
KEY = "hook:codex"


def day(offset):
    return (TODAY - datetime.timedelta(days=offset)).isoformat()


def summarize(tmp_path, days, window=7):
    path = tmp_path / "stats.json"
    path.write_text(json.dumps({"version": 1, "days": days, "events": {}}))
    return stats.summary(days=window, now=TODAY, path=str(path))


def test_missing_day_inside_window_adds_nothing(tmp_path):
    s = summarize(tmp_path, {day(2): {KEY: {"checked": 2}}, day(0): {KEY: {"checked": 3}}}, window=3)
    assert s["total"] == {"checked": 5, "blocked": 0, "warned": 0, "redacted": 0}
    assert s["since"] == day(2)


def test_today_missing_still_counts_earlier_days(tmp_path):
    s = summarize(tmp_path, {day(1): {KEY: {"checked": 4, "blocked": 1}}})
    assert s["total"]["checked"] == 4
    assert s["total"]["blocked"] == 1
    assert s["since"] == day(1)


def test_only_missing_days_give_no_since(tmp_path):
    s = summarize(tmp_path, {day(30): {KEY: {"checked": 9}}})
    assert s["since"] is None
    assert s["total"] == {"checked": 0, "blocked": 0, "warned": 0, "redacted": 0}
    assert s["byKey"] == {}


def test_day_with_only_blocked_counts_other_fields_as_zero(tmp_path):
    s = summarize(tmp_path, {day(0): {KEY: {"blocked": 2}}})
    assert s["total"] == {"checked": 0, "blocked": 2, "warned": 0, "redacted": 0}
    assert s["byKey"][KEY] == {"checked": 0, "blocked": 2, "warned": 0, "redacted": 0}
    assert s["detections"] == {}


def test_day_with_only_redactions_renders_without_warning_line(tmp_path):
    s = summarize(tmp_path, {day(0): {KEY: {"redacted": 3}}})
    text = stats.render(s)
    assert "3 secret values replaced" in text
    assert "warnings" not in text
    assert "Nothing recorded yet" not in text


def test_day_with_empty_entries_is_not_counted_but_sets_since(tmp_path):
    s = summarize(tmp_path, {day(3): {}, day(0): {KEY: {"checked": 1}}})
    assert s["total"]["checked"] == 1
    assert s["since"] == day(3)


def test_two_days_in_either_order_give_the_same_summary(tmp_path):
    older = {KEY: {"checked": 2, "blocked": 1, "detections": {"token": 1}}}
    newer = {KEY: {"checked": 5, "warned": 2, "detections": {"token": 2, "key": 1}}}
    a = summarize(tmp_path, {day(5): older, day(1): newer})
    b = summarize(tmp_path, {day(1): newer, day(5): older})
    assert a == b
    assert a["since"] == day(5)
    assert a["total"] == {"checked": 7, "blocked": 1, "warned": 2, "redacted": 0}
    assert a["detections"] == {"token": 3, "key": 1}
