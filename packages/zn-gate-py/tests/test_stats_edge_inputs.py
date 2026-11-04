"""Edge inputs for stats._num, stats.stats_file and stats.load, using temporary directories only."""

import datetime
import json
import os

import pytest

from zn_gate import stats

EMPTY = {"version": 1, "days": {}, "events": {}}
ZERO = {"checked": 0, "blocked": 0, "warned": 0, "redacted": 0}


@pytest.mark.parametrize("value", ["3.5", "0x10", "abc", "", "-0", "-7", -1, -0.5, 0.9, {}, [], (), float("nan")])
def test_num_gives_zero_for_non_numeric_or_non_positive(value):
    assert stats._num(value) == 0


@pytest.mark.parametrize("value,expected", [
    (" 7 ", 7), ("+4", 4), ("1_0", 10), (True, 1), (False, 0), (1.9, 1), (10 ** 20, 10 ** 20)])
def test_num_accepts_whole_number_forms(value, expected):
    assert stats._num(value) == expected


def test_stats_file_uses_zn_home_and_makes_it_absolute(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ZN_HOME", "relative-home")
    assert stats.stats_file() == str(tmp_path / "relative-home" / "stats.json")


def test_stats_file_ignores_an_empty_zn_home(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", "")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    assert stats.stats_file() == os.path.join(str(tmp_path), ".zn", "stats.json")


def test_load_reads_the_file_named_by_zn_home_when_no_path_is_given(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    (tmp_path / "stats.json").write_text(json.dumps({"days": {"2026-10-14": {}}}))
    assert stats.load() == {"days": {"2026-10-14": {}}}


def test_load_without_a_version_key_returns_the_data_as_it_is(tmp_path):
    p = tmp_path / "stats.json"
    p.write_text(json.dumps({"days": {}}))
    assert stats.load(str(p)) == {"days": {}}


def test_load_without_days_key_is_empty(tmp_path):
    p = tmp_path / "stats.json"
    p.write_text(json.dumps({"version": 1, "events": {"a": 1}}))
    assert stats.load(str(p)) == EMPTY


def test_load_keeps_extra_keys(tmp_path):
    data = {"version": 2, "days": {}, "events": {}, "note": "extra", "other": [1]}
    p = tmp_path / "stats.json"
    p.write_text(json.dumps(data))
    assert stats.load(str(p)) == data


def test_load_of_a_file_with_a_utf8_bom_is_empty(tmp_path):
    p = tmp_path / "stats.json"
    p.write_bytes(b"\xef\xbb\xbf" + json.dumps({"version": 1, "days": {}}).encode("utf-8"))
    assert stats.load(str(p)) == EMPTY


def test_load_when_a_folder_is_where_the_file_should_be(tmp_path):
    (tmp_path / "stats.json").mkdir()
    assert stats.load(str(tmp_path / "stats.json")) == EMPTY


def test_summary_when_a_folder_is_where_the_file_should_be(tmp_path, monkeypatch):
    (tmp_path / "stats.json").mkdir()
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    s = stats.summary()
    assert s["total"] == ZERO and s["since"] is None and s["events"] == {}


def test_summary_with_missing_counter_keys_and_extra_keys(tmp_path):
    p = tmp_path / "stats.json"
    p.write_text(json.dumps({"days": {"2026-10-14": {"hook:a": {"checked": "3", "blocked": "-2", "extra": 9}}}}))
    s = stats.summary(path=str(p), now=datetime.date(2026, 10, 14))
    assert s["total"] == {"checked": 3, "blocked": 0, "warned": 0, "redacted": 0}
    assert s["byKey"]["hook:a"] == s["total"]
