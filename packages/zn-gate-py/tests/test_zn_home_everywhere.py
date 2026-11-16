"""ZN_HOME moves the evidence ledger too, like the usage counts."""

import os
import subprocess
import sys


def _run(code, tmp_path, zn_home=None):
    env = dict(os.environ)
    env.pop("ZN_HOME", None)
    env["HOME"] = env["USERPROFILE"] = str(tmp_path / "fakehome")
    if zn_home is not None:
        env["ZN_HOME"] = str(zn_home)
    r = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_ledger_path_follows_zn_home(tmp_path):
    zh = tmp_path / "zh"
    out = _run("from zn_gate import evidence; print(evidence.EVIDENCE_FILE)", tmp_path, zh)
    assert out == os.path.join(os.path.abspath(str(zh)), "evidence.jsonl")


def test_log_evidence_writes_under_zn_home(tmp_path):
    zh = tmp_path / "zh"
    _run("from zn_gate import evidence; evidence.log_evidence({'agent': 't', 'payload': 'x', 'verdict': 'allow'})", tmp_path, zh)
    assert (zh / "evidence.jsonl").exists()
    assert not (tmp_path / "fakehome" / ".zn" / "evidence.jsonl").exists()


def test_without_zn_home_ledger_stays_in_dot_zn(tmp_path):
    out = _run("from zn_gate import evidence; print(evidence.EVIDENCE_FILE)", tmp_path)
    assert out == os.path.join(os.path.expanduser("~") if False else str(tmp_path / "fakehome"), ".zn", "evidence.jsonl")
