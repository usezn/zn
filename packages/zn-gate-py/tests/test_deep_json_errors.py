"""Deeply nested JSON in files the CLI reads must not crash it: json raises RecursionError, which is not a ValueError.

Everything is written inside a temporary folder. The nesting is only brackets, no payloads.
"""
import os
import subprocess
import sys

import pytest

from zn_gate import reach_history, stats
from zn_gate.evidence import EvidenceLedgerError, get_last_hash, log_evidence

DEEP = "[" * 100000
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def _run_cli(home, *args):
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["ZN_HOME"] = str(home)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    return subprocess.run(
        [sys.executable, "-m", "zn_gate", *args],
        capture_output=True, text=True, env=env, timeout=120,
    )


def _ledger_with_deep_last_line(tmp_path, trailing_newline=True):
    p = str(tmp_path / "evidence.jsonl")
    log_evidence({"payload": "example-0", "tool_name": "bash"}, file_path=p)
    with open(p, "ab") as f:
        f.write(DEEP.encode("ascii") + (b"\n" if trailing_newline else b""))
    return p


def test_stats_load_of_deeply_nested_file_gives_the_empty_default(tmp_path):
    p = tmp_path / "stats.json"
    p.write_text(DEEP, encoding="utf-8")
    assert stats.load(str(p)) == {"version": 1, "days": {}, "events": {}}


def test_stats_cli_on_deeply_nested_file_has_no_traceback(tmp_path):
    (tmp_path / "stats.json").write_text(DEEP, encoding="utf-8")
    result = _run_cli(tmp_path, "stats")
    assert result.returncode == 0, result.stderr
    assert "Traceback" not in result.stderr


@pytest.mark.parametrize("trailing_newline", [True, False])
def test_get_last_hash_with_deeply_nested_last_line_raises_the_ledger_error(tmp_path, trailing_newline):
    p = _ledger_with_deep_last_line(tmp_path, trailing_newline)
    with pytest.raises(EvidenceLedgerError):
        get_last_hash(p)


def test_log_evidence_refuses_to_append_after_a_deeply_nested_last_line(tmp_path):
    p = _ledger_with_deep_last_line(tmp_path)
    with open(p, "rb") as f:
        before = f.read()
    assert log_evidence({"payload": "after", "tool_name": "bash"}, file_path=p) is None
    with open(p, "rb") as f:
        assert f.read() == before


def test_reach_history_scan_of_a_deeply_nested_line_completes(tmp_path):
    p = tmp_path / "session.jsonl"
    p.write_text(DEEP + "\nplain line of ordinary text\n", encoding="utf-8")
    result = reach_history.scan_file(str(p), reach_history._now_ms() + 60000)
    assert result["complete"] is True
    assert isinstance(result["counts"], dict)
