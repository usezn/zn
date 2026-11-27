"""
The export copies the log once and reads only the copy. If the log cannot be copied, gets shorter while it
is copied, or is replaced meanwhile, the export refuses (exit 1, nothing written) and never reads the live
file instead, as the npm package does. Only temporary folders and invented values.
"""

import builtins

import pytest

from zn_gate import cli, evidence_timesketch as ts
from zn_gate.evidence import EvidenceLedgerError, export_evidence_ledger, log_evidence

FORMATS = ["jsonl", "csv", "timesketch", "timesketch-csv", "ocsf"]


def _ledger(tmp_path):
    p = tmp_path / "evidence.jsonl"
    for i in range(3):
        assert log_evidence({"verdict": "allow", "phase": "pre", "tool_name": f"example_tool_{i}"}, str(p))
    return p


@pytest.mark.parametrize("fmt", FORMATS)
def test_normal_copy_unchanged(tmp_path, fmt):
    p = _ledger(tmp_path)
    res = export_evidence_ledger(str(p), fmt)
    assert res["valid"] is True and not res.get("read_error") and res["total"] == 3


@pytest.mark.parametrize("fmt", FORMATS)
def test_log_shrinks_during_copy(tmp_path, monkeypatch, fmt):
    p = _ledger(tmp_path)
    real_fstat = ts.os.fstat
    calls = {"n": 0}

    def fstat(fd):
        st = real_fstat(fd)
        calls["n"] += 1
        if calls["n"] >= 2:  # the check after the copy sees a shorter log
            return type("S", (), {"st_size": st.st_size - 10, "st_ino": st.st_ino, "st_dev": st.st_dev})()
        return st

    monkeypatch.setattr(ts.os, "fstat", fstat)
    res = export_evidence_ledger(str(p), fmt)
    assert res["read_error"] is True and res["valid"] is False
    assert "got shorter" in res["error"] and res["content"].count("example_tool") == 0


@pytest.mark.parametrize("fmt", FORMATS)
def test_copy_fails_never_reads_live_file(tmp_path, monkeypatch, fmt):
    p = _ledger(tmp_path)
    real_open = builtins.open

    def fake_open(file, mode="r", *a, **k):
        if "x" in mode:
            raise OSError(28, "No space left on device")
        return real_open(file, mode, *a, **k)

    monkeypatch.setattr(builtins, "open", fake_open)
    res = export_evidence_ledger(str(p), fmt)
    assert res["read_error"] is True and res["valid"] is False
    assert "Cannot read the evidence log" in res["error"] and res["total"] == 0
    assert "example_tool" not in res["content"]


def test_log_replaced_during_copy(tmp_path, monkeypatch):
    p = _ledger(tmp_path)
    monkeypatch.setattr(ts, "_same_file", lambda fd, path: False)
    res = export_evidence_ledger(str(p), "jsonl")
    assert res["read_error"] is True and "replaced" in res["error"]


def test_missing_log_is_still_empty(tmp_path):
    res = export_evidence_ledger(str(tmp_path / "none.jsonl"), "jsonl")
    assert res["valid"] is True and res["total"] == 0 and not res.get("read_error")


def test_snapshot_raises_on_copy_error(tmp_path, monkeypatch):
    p = _ledger(tmp_path)
    monkeypatch.setattr(ts.tempfile, "mkdtemp", lambda prefix="": str(tmp_path / "missing" / "x"))
    with pytest.raises(EvidenceLedgerError):
        with ts.ledger_snapshot(str(p)):
            pass


def test_cli_refuses_with_exit_1_and_writes_nothing(tmp_path, monkeypatch, capsys):
    p = _ledger(tmp_path)
    out = tmp_path / "out.jsonl"
    monkeypatch.setattr(ts, "_same_file", lambda fd, path: False)
    monkeypatch.setattr(cli, "EVIDENCE_FILE", str(p))
    monkeypatch.setattr(cli, "export_evidence_ledger", lambda format="jsonl": export_evidence_ledger(str(p), format))
    args = type("A", (), {"export": True, "format": "jsonl", "output": str(out), "manifest": True})()
    assert cli.cmd_evidence(args) == 1
    assert not out.exists() and not (tmp_path / "out.jsonl.manifest.json").exists()
    err = capsys.readouterr().err
    assert "the export stopped. " in err and f"{out} was not written." in err
    assert "incomplete" not in err
