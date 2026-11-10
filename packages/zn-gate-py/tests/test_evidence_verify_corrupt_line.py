"""`zn-gate evidence --verify` on a ledger with one corrupted record: the command exits 1 and names the line
of that record on stderr. The ledger lives in a temporary ZN_HOME folder; the CLI runs as a real subprocess.
Fake values only."""

import json
import os
import subprocess
import sys
import tempfile

from zn_gate.evidence import log_evidence

_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def _write_ledger(path):
    for i in range(3):
        log_evidence({"payload": "example-%d" % i, "tool_name": "bash"}, file_path=path)
    with open(path, "rb") as f:
        return f.read().split(b"\n")


def _verify(home):
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    env["ZN_HOME"] = home
    return subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", "evidence", "--verify"],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )


def _damage_second_record(lines, kind):
    if kind == "altered":
        rec = json.loads(lines[1])
        rec["payload"] = "example-altered"
        lines[1] = json.dumps(rec, separators=(",", ":")).encode()
    else:  # truncated JSON
        lines[1] = lines[1][: len(lines[1]) // 2]
    return lines


def test_verify_exits_1_and_names_the_corrupted_line():
    for kind in ["altered", "truncated"]:
        with tempfile.TemporaryDirectory() as home:
            path = os.path.join(home, "evidence.jsonl")
            lines = _write_ledger(path)
            lines = _damage_second_record(lines, kind)
            with open(path, "wb") as f:
                f.write(b"\n".join(lines))
            proc = _verify(home)
            assert proc.returncode == 1, (kind, proc.returncode, proc.stdout, proc.stderr)
            assert "Tamper detected" in proc.stderr, kind
            assert "line 2" in proc.stderr, (kind, proc.stderr)


def test_verify_passes_on_an_intact_ledger():
    with tempfile.TemporaryDirectory() as home:
        _write_ledger(os.path.join(home, "evidence.jsonl"))
        proc = _verify(home)
        assert proc.returncode == 0, proc.stderr
        assert "ALL 3 RECORDS VERIFIED" in proc.stdout
