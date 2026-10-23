"""Counter behaviour of the read-only stats module and the verbose switch, and parity with the Node package."""

import datetime
import json
import pathlib
import shutil
import subprocess

import pytest

from zn_gate import stats
from zn_gate.verbose import is_verbose

NODE_LIB = pathlib.Path(__file__).resolve().parents[2] / "zn-gate" / "lib"
DAY = datetime.date(2026, 10, 14)
KEY = "hook:codex"


def entry(checked=0, blocked=0, warned=0, redacted=0, detections=None):
    return {"checked": checked, "blocked": blocked, "warned": warned, "redacted": redacted,
            "detections": detections or {}}


def summarize(tmp_path, entries):
    path = tmp_path / "stats.json"
    path.write_text(json.dumps({"version": 1, "days": {DAY.isoformat(): entries}, "events": {}}))
    return stats.summary(days=1, now=DAY, path=str(path))


def test_allow_counts_only_checked(tmp_path):
    s = summarize(tmp_path, {KEY: entry(checked=1)})
    assert s["total"] == {"checked": 1, "blocked": 0, "warned": 0, "redacted": 0}


def test_block_counts_checked_and_blocked(tmp_path):
    s = summarize(tmp_path, {KEY: entry(checked=1, blocked=1)})
    assert s["total"] == {"checked": 1, "blocked": 1, "warned": 0, "redacted": 0}
    assert "1 blocked" in stats.render(s)


def test_ask_is_counted_as_a_warning(tmp_path):
    s = summarize(tmp_path, {KEY: entry(checked=1, warned=1)})
    assert s["total"]["warned"] == 1
    assert "1 warnings" in stats.render(s)


def test_mixed_decisions_add_up_per_key(tmp_path):
    s = summarize(tmp_path, {KEY: entry(checked=3, blocked=1, warned=1), "mcp:client": entry(checked=2)})
    assert s["total"]["checked"] == 5
    assert s["byKey"][KEY]["blocked"] == 1
    assert s["byKey"]["mcp:client"]["checked"] == 2


def test_bad_numbers_count_as_zero(tmp_path):
    s = summarize(tmp_path, {KEY: {"checked": "x", "blocked": -4, "warned": None, "redacted": 2}})
    assert s["total"] == {"checked": 0, "blocked": 0, "warned": 0, "redacted": 2}


@pytest.mark.parametrize("content", ["", "{not json", "[]", "null", '{"days": []}', '{"days": 3}'])
def test_corrupt_file_reads_as_empty(tmp_path, content):
    path = tmp_path / "stats.json"
    path.write_text(content)
    s = stats.summary(path=str(path))
    assert s["total"] == {"checked": 0, "blocked": 0, "warned": 0, "redacted": 0}
    assert s["since"] is None


def test_missing_file_reads_as_empty(tmp_path):
    assert stats.load(str(tmp_path / "absent.json")) == {"version": 1, "days": {}, "events": {}}


def test_non_dict_entries_are_skipped(tmp_path):
    path = tmp_path / "stats.json"
    path.write_text(json.dumps({"days": {DAY.isoformat(): {KEY: 5, "hook:x": entry(checked=1)}, "2026-10-13": []}}))
    s = stats.summary(days=3, now=DAY, path=str(path))
    assert s["total"]["checked"] == 1


def test_verbose_on_and_off():
    assert is_verbose({"ZN_VERBOSE": "1"})
    assert is_verbose({"DEBUG": "zn-gate:*"})
    assert not is_verbose({"ZN_VERBOSE": "0"})
    assert not is_verbose({"DEBUG": "*"})
    assert not is_verbose({})


def test_verbose_reads_process_environment(monkeypatch):
    monkeypatch.delenv("DEBUG", raising=False)
    monkeypatch.setenv("ZN_VERBOSE", "1")
    assert is_verbose()
    monkeypatch.delenv("ZN_VERBOSE")
    assert not is_verbose()


def test_layer_names_match_node_layers():
    node_file = NODE_LIB / "stats.js"
    if not node_file.exists():
        pytest.skip("Node stats module not available")
    source = node_file.read_text()
    line = source.split("LAYERS = new Set([", 1)[1].split("]", 1)[0]
    node_layers = {p.strip().strip("'") for p in line.split(",")}
    assert set(stats.LAYER_NAMES) == node_layers


def test_keep_days_matches_node():
    node_file = NODE_LIB / "stats.js"
    if not node_file.exists():
        pytest.skip("Node stats module not available")
    assert "const KEEP_DAYS = %d;" % stats.KEEP_DAYS in node_file.read_text()


@pytest.mark.skipif(shutil.which("node") is None or not (NODE_LIB / "stats.js").exists(), reason="node or Node package not available")
def test_python_reads_counters_written_by_node(tmp_path):
    script = (
        "const s=require(%s);"
        "const o={file:process.argv[1],now:new Date('2026-10-14T12:00:00Z')};"
        "s.record({layer:'hook',agent:'codex',checked:1},o);"
        "s.record({layer:'hook',agent:'codex',checked:1,blocked:1,detections:{AWS_KEY:1}},o);"
        "s.record({layer:'hook',agent:'codex',checked:1,warned:1,redacted:2},o);"
        % json.dumps(str(NODE_LIB / "stats.js"))
    )
    path = tmp_path / "stats.json"
    subprocess.run(["node", "-e", script, str(path)], check=True, capture_output=True)
    s = stats.summary(days=1, now=DAY, path=str(path))
    assert s["total"] == {"checked": 3, "blocked": 1, "warned": 1, "redacted": 2}
    assert s["byKey"][KEY]["checked"] == 3
    assert s["detections"] == {"AWS_KEY": 1}
