"""More cases for the read-only stats module, run against a temporary HOME."""

import datetime
import json
import os

import pytest

from zn_gate import stats

TODAY = datetime.date(2026, 10, 14)


def entry(checked=0, blocked=0, warned=0, redacted=0, detections=None):
    return {"checked": checked, "blocked": blocked, "warned": warned, "redacted": redacted,
            "detections": detections or {}}


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.delenv("ZN_HOME", raising=False)
    monkeypatch.delenv("ZN_STATS", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    return tmp_path


def write_home(home, days):
    d = home / ".zn"
    d.mkdir(exist_ok=True)
    (d / "stats.json").write_text(json.dumps({"version": 1, "days": days, "events": {}}))


def test_default_file_is_under_home(home):
    assert stats.stats_file() == os.path.join(str(home), ".zn", "stats.json")


def test_zn_home_overrides_home(home, tmp_path):
    other = tmp_path / "elsewhere"
    os.environ["ZN_HOME"] = str(other)
    try:
        assert stats.stats_file() == str(other / "stats.json")
    finally:
        del os.environ["ZN_HOME"]


def test_summary_reads_from_temporary_home(home):
    write_home(home, {TODAY.isoformat(): {"hook:codex": entry(checked=2, blocked=1)}})
    s = stats.summary(days=1, now=TODAY)
    assert s["total"]["checked"] == 2 and s["total"]["blocked"] == 1


def test_missing_home_directory_reads_as_empty(home):
    s = stats.summary(now=TODAY)
    assert s == {"days": 30, "since": None, "total": {"checked": 0, "blocked": 0, "warned": 0, "redacted": 0},
                 "byKey": {}, "detections": {}, "events": {}}


def test_empty_file_and_empty_days(home):
    (home / ".zn").mkdir()
    (home / ".zn" / "stats.json").write_text("")
    assert stats.summary(now=TODAY)["since"] is None
    write_home(home, {})
    assert stats.summary(now=TODAY)["byKey"] == {}


def test_damaged_file_renders_nothing_recorded(home):
    (home / ".zn").mkdir()
    (home / ".zn" / "stats.json").write_bytes(b'{"days": {"2026-10-14": ')
    text = stats.render(stats.summary(now=TODAY))
    assert "Nothing recorded yet" in text
    assert "counting since" not in text


def test_counters_are_kept_per_agent_across_days(home):
    write_home(home, {
        "2026-10-14": {"hook:codex": entry(checked=2, redacted=1), "mcp:client": entry(checked=1, blocked=1)},
        "2026-10-13": {"hook:codex": entry(checked=4, warned=2)},
    })
    s = stats.summary(days=7, now=TODAY)
    assert s["byKey"]["hook:codex"] == {"checked": 6, "blocked": 0, "warned": 2, "redacted": 1}
    assert s["byKey"]["mcp:client"] == {"checked": 1, "blocked": 1, "warned": 0, "redacted": 0}
    assert s["total"] == {"checked": 7, "blocked": 1, "warned": 2, "redacted": 1}


def test_since_is_oldest_day_whatever_the_file_order(home):
    write_home(home, {
        "2026-10-14": {"hook:a": entry(checked=1)},
        "2026-10-09": {"hook:a": entry(checked=1)},
        "2026-10-12": {"hook:a": entry(checked=1)},
    })
    assert stats.summary(days=30, now=TODAY)["since"] == "2026-10-09"


def test_window_includes_cutoff_day_and_excludes_older(home):
    write_home(home, {
        "2026-10-08": {"hook:a": entry(checked=10)},
        "2026-10-07": {"hook:a": entry(checked=100)},
    })
    s = stats.summary(days=7, now=TODAY)
    assert s["total"]["checked"] == 10 and s["since"] == "2026-10-08"


def test_future_days_are_still_counted(home):
    write_home(home, {"2026-10-20": {"hook:a": entry(checked=3)}})
    assert stats.summary(days=1, now=TODAY)["total"]["checked"] == 3


def test_numbers_are_truncated_to_whole_counts(home):
    write_home(home, {"2026-10-14": {"hook:a": {"checked": 2.9, "blocked": "3", "warned": 0.5, "redacted": True}}})
    s = stats.summary(days=1, now=TODAY)
    assert s["total"] == {"checked": 2, "blocked": 3, "warned": 0, "redacted": 1}


def test_render_groups_thousands(home):
    write_home(home, {"2026-10-14": {"hook:a": entry(checked=1234567, blocked=1000, redacted=12345)}})
    text = stats.render(stats.summary(days=1, now=TODAY))
    assert "1,234,567 events checked" in text
    assert "1,000 blocked" in text and "12,345 secret values" in text


def test_render_day_wording_and_warning_line(home):
    write_home(home, {"2026-10-14": {"hook:a": entry(checked=1)}})
    one = stats.render(stats.summary(days=1, now=TODAY))
    assert "last 1 day (counting since 2026-10-14):" in one
    assert "warnings" not in one
    many = stats.render(stats.summary(days=5, now=TODAY))
    assert "last 5 days" in many


def test_render_orders_agents_by_checked_and_names_layers(home):
    write_home(home, {"2026-10-14": {
        "hook:small": entry(checked=1),
        "shield:big": entry(checked=9),
        "odd:mid": entry(checked=5),
    }})
    text = stats.render(stats.summary(days=1, now=TODAY))
    assert text.index("big (shield (wrapped MCP servers))") < text.index("mid (odd)") < text.index("small (agent hooks)")


def test_render_lists_at_most_eight_secret_types_by_count(home):
    dets = {"T%d" % i: i for i in range(1, 11)}
    write_home(home, {"2026-10-14": {"hook:a": entry(checked=1, detections=dets)}})
    line = [l for l in stats.render(stats.summary(days=1, now=TODAY)).splitlines() if "Secret types found" in l][0]
    assert line.endswith("T10 10, T9 9, T8 8, T7 7, T6 6, T5 5, T4 4, T3 3")


def test_detections_are_summed_across_agents_and_days(home):
    write_home(home, {
        "2026-10-14": {"hook:a": entry(checked=1, detections={"K": 1}), "mcp:b": entry(checked=1, detections={"K": 2})},
        "2026-10-13": {"hook:a": entry(checked=1, detections={"K": 4, "J": 1})},
    })
    assert stats.summary(days=3, now=TODAY)["detections"] == {"K": 7, "J": 1}


def test_off_switch_does_not_hide_existing_counts(home, monkeypatch):
    # ZN_STATS=off only stops the npm package from recording; reading still works.
    write_home(home, {"2026-10-14": {"hook:a": entry(checked=2)}})
    monkeypatch.setenv("ZN_STATS", "off")
    assert stats.summary(days=1, now=TODAY)["total"]["checked"] == 2


def test_off_switch_with_no_file_stays_empty_and_creates_nothing(home, monkeypatch):
    monkeypatch.setenv("ZN_STATS", "off")
    assert stats.summary(now=TODAY)["total"]["checked"] == 0
    assert not (home / ".zn").exists()


def test_events_are_passed_through_as_a_copy(home):
    d = home / ".zn"
    d.mkdir()
    (d / "stats.json").write_text(json.dumps({"days": {}, "events": {"shared": 2}}))
    assert stats.summary(now=TODAY)["events"] == {"shared": 2}
