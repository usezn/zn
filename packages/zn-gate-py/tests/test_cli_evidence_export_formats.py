"""
The evidence command: export in csv and jsonl (to stdout and to a file) and
verify on a missing, an empty and a one-record ledger. Pins exit codes and the
first line of each output. Only temporary directories and invented values.
"""

import json

import pytest

from zn_gate import cli
from zn_gate.evidence import (
    export_evidence_ledger,
    log_evidence,
    verify_evidence_ledger,
)

CSV_HEADER = (
    "timestamp,verdict,phase,tool_name,agent_environment,rule,reason,"
    "payload_sha256,record_hash,prev_hash,latency_us"
)


def _ledger(tmp_path, kind):
    p = tmp_path / "evidence.jsonl"
    if kind == "empty":
        p.write_text("", encoding="utf-8")
    elif kind == "one":
        rec = log_evidence({"verdict": "allow", "phase": "pre", "tool_name": "example_tool"}, str(p))
        assert rec is not None
    return str(p)


@pytest.fixture
def run(monkeypatch, capsys):
    def _run(path, **kw):
        monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: verify_evidence_ledger(path))
        monkeypatch.setattr(cli, "export_evidence_ledger",
                            lambda format="jsonl": export_evidence_ledger(path, format))
        args = type("A", (), kw)()
        code = cli.cmd_evidence(args)
        return code, capsys.readouterr()
    return _run


def _first(text):
    return text.split("\n")[0]


# ------------------------------------------------------------------- export

@pytest.mark.parametrize("kind", ["missing", "empty"])
def test_export_csv_stdout_without_records_prints_header(tmp_path, run, kind):
    code, cap = run(_ledger(tmp_path, kind), export=True, format="csv", output=None)
    assert code == 0
    assert _first(cap.out) == CSV_HEADER


@pytest.mark.parametrize("kind", ["missing", "empty"])
def test_export_jsonl_stdout_without_records_prints_blank_first_line(tmp_path, run, kind):
    code, cap = run(_ledger(tmp_path, kind), export=True, format="jsonl", output=None)
    assert code == 0
    assert _first(cap.out) == ""


def test_export_csv_stdout_one_record(tmp_path, run):
    code, cap = run(_ledger(tmp_path, "one"), export=True, format="csv", output=None)
    assert code == 0
    lines = cap.out.splitlines()
    assert lines[0] == CSV_HEADER
    assert len(lines) >= 2 and "example_tool" in lines[1]


def test_export_jsonl_stdout_one_record(tmp_path, run):
    code, cap = run(_ledger(tmp_path, "one"), export=True, format="jsonl", output=None)
    assert code == 0
    first = json.loads(_first(cap.out))
    assert first["tool_name"] == "example_tool"
    assert len(first["record_hash"]) == 64


@pytest.mark.parametrize("fmt", ["csv", "jsonl"])
@pytest.mark.parametrize("kind", ["missing", "empty", "one"])
def test_export_to_file(tmp_path, run, fmt, kind):
    out = tmp_path / ("out." + fmt)
    code, cap = run(_ledger(tmp_path, kind), export=True, format=fmt, output=str(out))
    assert code == 0
    total = 1 if kind == "one" else 0
    assert _first(cap.out) == f"Exported {total} records to {out} (Integrity: VALID)."
    body = out.read_text(encoding="utf-8")
    if fmt == "csv":
        assert _first(body) == CSV_HEADER
    elif kind == "one":
        assert json.loads(_first(body))["tool_name"] == "example_tool"
    else:
        assert _first(body) == ""


# ------------------------------------------------------------------- verify

def test_verify_missing_ledger(tmp_path, run):
    code, cap = run(_ledger(tmp_path, "missing"), verify=True)
    assert code == 0
    assert "ALL 0 RECORDS VERIFIED" in cap.out
    assert _first(cap.out) == ""  # output starts with a blank line


def test_verify_empty_ledger(tmp_path, run):
    code, cap = run(_ledger(tmp_path, "empty"), verify=True)
    assert code == 0
    assert "ALL 0 RECORDS VERIFIED (IMMUTABLE)" in cap.out.splitlines()[1]


def test_verify_one_record(tmp_path, run):
    code, cap = run(_ledger(tmp_path, "one"), verify=True)
    assert code == 0
    assert "ALL 1 RECORDS VERIFIED (IMMUTABLE)" in cap.out.splitlines()[1]
