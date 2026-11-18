"""A JSON value nested 100000 levels deep, in a file the CLI reads, is handled as unreadable
data: no RecursionError escapes stats.load, evidence.get_last_hash or reach_history.scan_line."""

import pytest

from zn_gate import evidence, reach_history, stats

DEPTH = 100000
EMPTY_STATS = {"version": 1, "days": {}, "events": {}}


def _deep_array(depth=DEPTH):
    return "[" * depth + "]" * depth


def _deep_object(depth=DEPTH):
    return '{"a":' * depth + "1" + "}" * depth


def test_stats_load_treats_deep_array_as_missing_stats(tmp_path):
    p = tmp_path / "stats.json"
    p.write_text(_deep_array(), encoding="utf-8")
    assert stats.load(str(p)) == EMPTY_STATS


def test_stats_load_treats_deep_object_as_missing_stats(tmp_path):
    p = tmp_path / "stats.json"
    p.write_text(_deep_object(), encoding="utf-8")
    assert stats.load(str(p)) == EMPTY_STATS


def test_get_last_hash_raises_ledger_error_for_deep_last_line(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    evidence.log_evidence({"payload": "one"}, file_path=p)
    with open(p, "ab") as f:
        f.write(_deep_array().encode("utf-8") + b"\n")
    with pytest.raises(evidence.EvidenceLedgerError, match="Malformed JSON in the last line"):
        evidence.get_last_hash(p)


@pytest.mark.parametrize("make_line", [_deep_array, _deep_object])
def test_log_evidence_returns_none_for_deep_last_line(tmp_path, make_line):
    p = str(tmp_path / "evidence.jsonl")
    evidence.log_evidence({"payload": "one"}, file_path=p)
    with open(p, "ab") as f:
        f.write(make_line().encode("utf-8") + b"\n")
    assert evidence.log_evidence({"payload": "two"}, file_path=p) is None


def test_scan_line_does_not_raise_for_deep_nesting():
    counts = {}
    reach_history.scan_line(_deep_array(), counts)
    reach_history.scan_line(_deep_object(), counts)
