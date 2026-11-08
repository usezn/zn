"""Python CLI edge cases: empty analyze text, a removed record in a three-record
evidence ledger reported by verify, and a secret that sits only under node_modules.
Every value is invented and assembled at runtime."""
import argparse
import datetime
import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout

from zn_gate import cli, stats
from zn_gate.evidence import log_evidence, verify_evidence_ledger

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"


def _env():
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    for name in ("ZN_CLOUD", "ZN_API_KEY", "ZN_API_URL", "ZN_STAGE"):
        env.pop(name, None)
    return env


def test_analyze_empty_text_is_a_usage_error():
    proc = subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", "analyze", ""],
        capture_output=True, text=True, env=_env(), timeout=60,
    )
    assert proc.returncode == 2, proc.stdout
    assert proc.stdout == ""
    assert "usage:" in proc.stderr


def test_removed_record_in_three_record_ledger_fails_verify_cli(tmp_path, monkeypatch, capsys):
    p = str(tmp_path / "evidence.jsonl")
    for i in range(3):
        log_evidence({"payload": f"example-{i}", "tool_name": "bash"}, file_path=p)
    with open(p, "rb") as f:
        lines = f.read().split(b"\n")[:-1]
    assert len(lines) == 3
    del lines[1]
    with open(p, "wb") as f:
        f.write(b"\n".join(lines) + b"\n")
    res = verify_evidence_ledger(p)
    assert res["valid"] is False
    monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: verify_evidence_ledger(p))
    code = cli.cmd_evidence(type("A", (), {"verify": True})())
    assert code != 0
    assert "Broken chain link at line 2" in capsys.readouterr().err


def _scan_json(path):
    from zn_gate.cli import cmd_scan
    ns = argparse.Namespace(path=str(path), exclude=None, include=None, format="json", no_fail=False)
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = cmd_scan(ns)
    return code, json.loads(buf.getvalue())


def test_secret_only_under_node_modules_is_not_reported(tmp_path):
    pkg = tmp_path / "with_modules" / "node_modules" / "pkg"
    pkg.mkdir(parents=True)
    (tmp_path / "with_modules" / "ok.md").write_text("hello\n", encoding="utf-8")
    (pkg / "settings.env").write_text(f"AWS_ACCESS_KEY_ID={FAKE_AWS}\n", encoding="utf-8")
    code, data = _scan_json(tmp_path / "with_modules")
    assert data["total_secrets"] == 0
    assert code == 0


def test_same_secret_outside_node_modules_is_reported(tmp_path):
    src = tmp_path / "plain" / "src"
    src.mkdir(parents=True)
    (src / "settings.env").write_text(f"AWS_ACCESS_KEY_ID={FAKE_AWS}\n", encoding="utf-8")
    code, data = _scan_json(tmp_path / "plain")
    assert data["total_secrets"] >= 1
    assert code == 1


def test_stats_render_does_not_print_control_characters_from_labels(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    bell = chr(7)
    esc = chr(27)
    day = {
        "hook:" + esc + "[31mcodex" + bell: {
            "checked": 3, "blocked": 1, "warned": 0, "redacted": 0,
            "detections": {"AWS" + esc + "[31m_KEY" + bell: 2},
        },
    }
    (tmp_path / "stats.json").write_text(json.dumps({"version": 1, "days": {"2026-11-07": day}, "events": {}}), encoding="utf-8")
    text = stats.render(stats.summary(days=30, now=datetime.date(2026, 11, 7)))
    assert esc not in text
    assert bell not in text
    assert "codex" in text and "AWS" in text and "_KEY" in text


def test_stats_render_cleans_the_layer_label_too(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    esc = chr(27)
    day = {"ho" + esc + "[2Jok:agent": {"checked": 1, "blocked": 0, "warned": 0, "redacted": 0, "detections": {}}}
    (tmp_path / "stats.json").write_text(json.dumps({"version": 1, "days": {"2026-11-07": day}, "events": {}}), encoding="utf-8")
    text = stats.render(stats.summary(days=30, now=datetime.date(2026, 11, 7)))
    assert esc not in text
    assert "agent" in text


def test_stats_render_cleans_a_detection_type_alone(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    day = {"hook:codex": {"checked": 1, "blocked": 0, "warned": 0, "redacted": 0,
                          "detections": {"TOKEN" + chr(0) + chr(27) + "]0;title" + chr(7) + chr(0x202e): 1}}}
    (tmp_path / "stats.json").write_text(json.dumps({"version": 1, "days": {"2026-11-07": day}, "events": {}}), encoding="utf-8")
    text = stats.render(stats.summary(days=30, now=datetime.date(2026, 11, 7)))
    for bad in (chr(0), chr(27), chr(7), chr(0x202e)):
        assert bad not in text
    assert "TOKEN" in text
