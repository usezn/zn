"""
evidence --export --format ocsf: one OCSF Detection Finding (class 2004) per record, the zn_ fields
under unmapped, the preview only on request, a record with no valid time kept with time 0, and exit
code 1 when the chain does not verify. Only temporary folders and invented values.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from zn_gate import evidence as ev
from zn_gate import evidence_timesketch as ts

SRC = str(Path(__file__).resolve().parents[1] / "src")
TOP_KEYS = [
    "activity_id", "category_uid", "category_name", "class_uid", "class_name", "type_uid",
    "action_id", "disposition_id", "severity_id", "time", "message", "finding_info", "metadata",
    "cloud", "osint", "unmapped",
]


def _home(tmp_path, records):
    home = tmp_path / "home"
    home.mkdir()
    log = home / "evidence.jsonl"
    for r in records:
        ev.log_evidence(r, str(log))
    return home, log


def _run(home, *args):
    env = {**os.environ, "ZN_HOME": str(home), "PYTHONPATH": SRC, "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run([sys.executable, "-m", "zn_gate", "evidence", "--export", "--format", "ocsf", *args],
                          capture_output=True, text=True, env=env, timeout=120)


RECORDS = [
    {"verdict": "allow", "tool_name": "shell", "agent_environment": "agent-a", "payload": "first preview text"},
    {"verdict": "block", "tool_name": "shell", "agent_environment": "agent-a", "rule": "zn_state"},
]


def test_detection_finding_fields_and_order(tmp_path):
    home, _ = _home(tmp_path, RECORDS)
    lines = _run(home).stdout.splitlines()
    first = json.loads(lines[0])
    assert list(first) == TOP_KEYS
    assert first["class_uid"] == 2004 and first["category_uid"] == 2 and first["type_uid"] == 200401
    assert first["activity_id"] == 1
    assert first["action_id"] == 1 and first["disposition_id"] == 1 and first["severity_id"] == 1
    assert first["metadata"]["version"] == "1.7.0"
    assert first["metadata"]["product"]["name"] == "zn-gate" and first["metadata"]["product"]["vendor_name"] == "zn"
    assert first["cloud"] == {"provider": "local"} and first["osint"] == []
    assert first["message"] == "allow shell by agent-a"
    assert first["finding_info"]["title"] == first["message"]
    assert first["unmapped"]["zn_chain_verified"] is True and first["unmapped"]["zn_chain_index"] == 0
    assert first["unmapped"]["zn_tool"] == "shell" and first["unmapped"]["zn_agent"] == "agent-a"
    assert "zn_payload_preview" not in first["unmapped"]
    assert "payload_preview" not in lines[0]
    second = json.loads(lines[1])
    assert second["action_id"] == 2 and second["disposition_id"] == 2 and second["severity_id"] == 3
    assert second["message"] == "block shell by agent-a (rule zn_state)"
    assert second["unmapped"]["zn_rule"] == "zn_state"


def test_preview_only_with_flag(tmp_path):
    home, _ = _home(tmp_path, RECORDS)
    assert "zn_payload_preview" not in _run(home).stdout
    first = json.loads(_run(home, "--include-preview").stdout.splitlines()[0])
    assert first["unmapped"]["zn_payload_preview"] == "first preview text"
    keys = list(first["unmapped"])
    assert keys.index("zn_payload_preview") == keys.index("zn_chain_index") - 1


def test_time_is_epoch_milliseconds_and_floored(tmp_path):
    log = tmp_path / "evidence.jsonl"
    ev.log_evidence({"verdict": "allow", "tool_name": "t"}, str(log))
    rec = json.loads(log.read_text(encoding="utf-8"))
    rec["timestamp"] = "1969-12-31T23:59:59.999999Z"
    out = ts.ocsf_event(rec, 0, True)
    assert out["time"] == -1  # -1 microsecond is -1 whole millisecond, rounded down
    rec["timestamp"] = "2026-11-26T19:30:00.123456Z"
    assert ts.ocsf_event(rec, 0, True)["time"] == 1795721400123


def test_record_without_valid_time_is_kept_with_time_zero(tmp_path):
    log = tmp_path / "evidence.jsonl"
    ev.log_evidence({"verdict": "allow", "tool_name": "t"}, str(log))
    rec = json.loads(log.read_text(encoding="utf-8"))
    rec["timestamp"] = "2026-02-30T00:00:00Z"
    out = ts.ocsf_event(rec, 0, False)
    assert out["time"] == 0
    assert out["unmapped"]["zn_time_unmapped"] is True
    assert out["unmapped"]["zn_timestamp"] == "2026-02-30T00:00:00Z"
    assert out["unmapped"]["zn_chain_verified"] is False


def test_deny_is_read_as_block(tmp_path):
    out = ts.ocsf_event({"verdict": "deny", "timestamp": "2026-01-01T00:00:00Z"}, 0, True)
    block = ts.ocsf_event({"verdict": "block", "timestamp": "2026-01-01T00:00:00Z"}, 0, True)
    assert (out["action_id"], out["disposition_id"], out["severity_id"]) == (2, 2, 3)
    assert {k: out[k] for k in ("action_id", "disposition_id", "severity_id")} == {k: block[k] for k in ("action_id", "disposition_id", "severity_id")}


def test_unknown_verdict_is_unknown(tmp_path):
    out = ts.ocsf_event({"verdict": "warn", "timestamp": "2026-01-01T00:00:00Z"}, 0, True)
    assert (out["action_id"], out["disposition_id"], out["severity_id"]) == (0, 0, 0)


def test_tampered_log_exits_1_and_manifest_works(tmp_path):
    home, log = _home(tmp_path, RECORDS + [{"verdict": "allow", "tool_name": "third"}])
    lines = log.read_text(encoding="utf-8").split("\n")
    lines[1] = lines[1].replace('"verdict":"block"', '"verdict":"allow"', 1)
    log.write_text("\n".join(lines), encoding="utf-8")
    out = tmp_path / "out.ocsf"
    proc = _run(home, "--output", str(out), "--manifest")
    assert proc.returncode == 1
    assert proc.stderr.splitlines()[0].startswith("Tamper detected: Tamper detected at line 2 (record ")
    manifest = json.loads((tmp_path / "out.ocsf.manifest.json").read_text(encoding="utf-8"))
    assert manifest["format"] == "ocsf" and manifest["chain_verified"] is False
    assert manifest["chain_break_index"] == 1


def test_missing_ledger_gives_empty_output(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    proc = _run(home)
    assert proc.returncode == 0 and proc.stdout == ""
