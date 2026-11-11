"""
`zn-gate evidence --export` on a changed ledger writes the file, prints the
tamper warning and exits 1, as --verify does. A clean ledger exports with 0.
Each run uses a throwaway ZN_HOME and invented values only.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from zn_gate.evidence import log_evidence

SRC = Path(__file__).resolve().parents[1] / "src"


def _home(tmp_path):
    home = tmp_path / "zn-home"
    home.mkdir()
    ledger = home / "evidence.jsonl"
    for i in range(2):
        rec = log_evidence({"verdict": "allow", "phase": "pre", "tool_name": f"example_tool_{i}"}, str(ledger))
        assert rec is not None
    return home, ledger


def _export(home, out, fmt):
    env = {**os.environ, "ZN_HOME": str(home), "PYTHONPATH": str(SRC), "NO_COLOR": "1"}
    return subprocess.run(
        [sys.executable, "-m", "zn_gate", "evidence", "--export", "--format", fmt, "--output", str(out)],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )


@pytest.mark.parametrize("fmt, lines", [("jsonl", 2), ("csv", 3)])
def test_export_of_tampered_ledger_writes_file_warns_and_exits_1(tmp_path, fmt, lines):
    home, ledger = _home(tmp_path)
    text = ledger.read_text(encoding="utf-8")
    changed = text.replace("example_tool_0", "example_tool_9")
    assert changed != text
    ledger.write_text(changed, encoding="utf-8")
    out = tmp_path / f"export.{fmt}"

    r = _export(home, out, fmt)

    assert r.returncode == 1, r.stdout + r.stderr
    assert "Tamper detected" in r.stderr
    assert "Integrity: TAMPERED" in r.stdout
    written = out.read_text(encoding="utf-8").splitlines()
    assert len(written) == lines
    if fmt == "jsonl":
        for line in written:
            json.loads(line)


@pytest.mark.parametrize("fmt, lines", [("jsonl", 2), ("csv", 3)])
def test_export_of_clean_ledger_exits_0(tmp_path, fmt, lines):
    home, _ledger = _home(tmp_path)
    out = tmp_path / f"export.{fmt}"

    r = _export(home, out, fmt)

    assert r.returncode == 0, r.stdout + r.stderr
    assert "Tamper detected" not in r.stderr
    assert "Integrity: VALID" in r.stdout
    assert len(out.read_text(encoding="utf-8").splitlines()) == lines
