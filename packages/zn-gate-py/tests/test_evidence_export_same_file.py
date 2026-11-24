"""
`evidence --export --output` never writes over the evidence log itself, nor over a symlink or a hard link to it.
The check runs before the export is read or the output is written; the log is left as it was and the exit code is 2.
Only temporary folders and invented values.
"""

import os
import sys

import pytest

from zn_gate import cli
from zn_gate.evidence import export_evidence_ledger, log_evidence

REFUSAL = "the output file is the evidence log itself; choose another path"
LINKS_SKIP = pytest.mark.skipif(
    sys.platform == "win32",
    reason="symlink and hard link cases are not created on Windows; the Linux run covers them",
)


def _ledger(tmp_path):
    p = tmp_path / "evidence.jsonl"
    for i in range(2):
        rec = log_evidence({"verdict": "allow", "phase": "pre", "tool_name": f"example_tool_{i}"}, str(p))
        assert rec is not None
    return p


@pytest.fixture
def run(monkeypatch, capsys):
    def _run(ledger, output):
        monkeypatch.setattr(cli, "EVIDENCE_FILE", str(ledger))
        monkeypatch.setattr(cli, "export_evidence_ledger",
                            lambda format="jsonl": export_evidence_ledger(str(ledger), format))
        args = type("A", (), {"export": True, "format": "jsonl", "output": str(output)})()
        code = cli.cmd_evidence(args)
        return code, capsys.readouterr()
    return _run


def _assert_refused(code, cap, ledger, before):
    assert code == 2
    assert REFUSAL in cap.err
    assert before, "the log had records before the export"
    assert ledger.read_bytes() == before


def test_export_onto_the_ledger_itself_is_refused(tmp_path, run):
    ledger = _ledger(tmp_path)
    before = ledger.read_bytes()
    code, cap = run(ledger, ledger)
    _assert_refused(code, cap, ledger, before)


@LINKS_SKIP
def test_export_onto_a_symlink_to_the_ledger_is_refused(tmp_path, run):
    ledger = _ledger(tmp_path)
    link = tmp_path / "alias.jsonl"
    try:
        os.symlink(ledger, link)
    except OSError as err:
        pytest.skip(f"symlinks cannot be created here ({err})")
    before = ledger.read_bytes()
    code, cap = run(ledger, link)
    _assert_refused(code, cap, ledger, before)
    assert os.path.islink(link)


@LINKS_SKIP
def test_export_onto_a_hard_link_to_the_ledger_is_refused(tmp_path, run):
    ledger = _ledger(tmp_path)
    hard = tmp_path / "copy.jsonl"
    os.link(ledger, hard)
    before = ledger.read_bytes()
    code, cap = run(ledger, hard)
    _assert_refused(code, cap, ledger, before)


def test_export_to_a_normal_different_path_still_works(tmp_path, run):
    ledger = _ledger(tmp_path)
    before = ledger.read_bytes()
    out = tmp_path / "export.out"
    code, cap = run(ledger, out)
    assert code == 0
    assert "Exported 2 records" in cap.out
    lines = [line for line in out.read_text(encoding="utf-8").split("\n") if line]
    assert len(lines) == 2
    assert ledger.read_bytes() == before
