import argparse
import json
import os
import shutil
import tempfile

from zn_gate.evidence import log_evidence, verify_evidence_ledger, get_evidence_stats, export_evidence_ledger, GENESIS_HASH


def test_evidence_engine_append_and_verify():
    tmp_dir = tempfile.mkdtemp(prefix="zn_ev_py_test_")
    test_ledger = os.path.join(tmp_dir, "evidence.jsonl")

    try:
        rec1 = log_evidence(
            {
                "agent": "langchain-agent",
                "phase": "tool-call",
                "tool_name": "bash",
                "payload": "cat ~/.ssh/id_rsa",
                "verdict": "block",
                "rule": "LFI_SSH_PATTERN",
                "confidence": 1.0,
                "latency_us": 25,
                "engine": "python-deterministic",
            },
            file_path=test_ledger,
        )

        assert rec1["prev_hash"] == GENESIS_HASH
        assert len(rec1["record_hash"]) == 64
        assert rec1["verdict"] == "block"

        rec2 = log_evidence(
            {
                "agent": "crewai",
                "phase": "tool-result",
                "tool_name": "postgres",
                "payload": "SELECT 1",
                "verdict": "allow",
                "confidence": 1.0,
                "latency_us": 10,
                "engine": "python-deterministic",
            },
            file_path=test_ledger,
        )

        assert rec2["prev_hash"] == rec1["record_hash"]
        assert len(rec2["record_hash"]) == 64

        stats = get_evidence_stats(test_ledger)
        assert stats["total"] == 2
        assert stats["blocks"] == 1
        assert stats["allows"] == 1

        check = verify_evidence_ledger(test_ledger)
        assert check["valid"] is True
        assert check["total"] == 2
        assert check["verified"] == 2

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_evidence_engine_tamper_detection():
    tmp_dir = tempfile.mkdtemp(prefix="zn_ev_py_tamper_")
    test_ledger = os.path.join(tmp_dir, "evidence.jsonl")

    try:
        log_evidence({"agent": "a", "tool_name": "t1", "verdict": "block", "rule": "R1"}, file_path=test_ledger)
        log_evidence({"agent": "b", "tool_name": "t2", "verdict": "allow"}, file_path=test_ledger)
        log_evidence({"agent": "c", "tool_name": "t3", "verdict": "block", "rule": "R2"}, file_path=test_ledger)

        initial_check = verify_evidence_ledger(test_ledger)
        assert initial_check["valid"] is True
        assert initial_check["total"] == 3

        # Tamper record 0 (change block to allow)
        with open(test_ledger, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]

        rec0 = json.loads(lines[0])
        rec0["verdict"] = "allow"
        lines[0] = json.dumps(rec0, separators=(",", ":"))

        with open(test_ledger, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

        tampered_check = verify_evidence_ledger(test_ledger)
        assert tampered_check["valid"] is False
        assert tampered_check["broken_index"] == 0

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_evidence_engine_export():
    tmp_dir = tempfile.mkdtemp(prefix="zn_ev_py_export_")
    test_ledger = os.path.join(tmp_dir, "evidence.jsonl")

    try:
        log_evidence({"agent": "agent-a", "phase": "tool-call", "tool_name": "bash", "payload": "whoami", "verdict": "allow", "latency_us": 15}, file_path=test_ledger)
        log_evidence({"agent": "agent-b", "phase": "tool-call", "tool_name": "bash", "payload": "cat /etc/passwd", "verdict": "block", "rule": "path:sensitive_file", "latency_us": 20}, file_path=test_ledger)

        jsonl_exp = export_evidence_ledger(test_ledger, format="jsonl")
        assert jsonl_exp["format"] == "jsonl"
        assert jsonl_exp["valid"] is True
        assert jsonl_exp["total"] == 2
        assert "whoami" in jsonl_exp["content"]
        assert "path:sensitive_file" in jsonl_exp["content"]

        csv_exp = export_evidence_ledger(test_ledger, format="csv")
        assert csv_exp["format"] == "csv"
        assert csv_exp["valid"] is True
        assert csv_exp["total"] == 2
        assert csv_exp["content"].startswith("timestamp,verdict,phase,tool_name")
        assert '"allow"' in csv_exp["content"]
        assert '"block"' in csv_exp["content"]
        assert '"path:sensitive_file"' in csv_exp["content"]

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_log_evidence_writes_only_to_the_given_file(tmp_path, monkeypatch):
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("ZN_HOME", str(tmp_path / "zn-home"))
    target = tmp_path / "ledger" / "evidence.jsonl"
    from zn_gate.evidence import log_evidence
    log_evidence({"verdict": "ALLOW", "tool_name": "t", "payload": "x"}, file_path=str(target))
    assert target.is_file()
    assert not (fake_home / ".zn").exists()
    assert not (tmp_path / "zn-home").exists()
    for p in tmp_path.rglob("*"):
        assert p == target or p == target.parent or p == fake_home or p.name.startswith(target.name) \
            or p.parent == target.parent


# Fixed records (fake hashes, reserved values) so the CLI output is byte-stable.
# The expected bytes match what the Node package writes for the same ledger.
_FIXED_RECORDS = [
    {
        "timestamp": "2026-01-01T00:00:00Z",
        "verdict": "allow",
        "phase": "tool-call",
        "tool_name": "bash",
        "agent_environment": "agent-a",
        "rule": "",
        "reason": "",
        "payload_sha256": "a" * 64,
        "record_hash": "b" * 64,
        "prev_hash": GENESIS_HASH,
        "latency_us": 15,
    },
    {
        "timestamp": "2026-01-01T00:00:01Z",
        "verdict": "block",
        "phase": "tool-call",
        "tool_name": "bash",
        "agent_environment": "agent-b",
        "rule": "path:sensitive_file",
        "reason": 'says "no"',
        "payload_sha256": "c" * 64,
        "record_hash": "d" * 64,
        "prev_hash": "b" * 64,
        "latency_us": 20,
    },
]

_CSV_HEADER = "timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us"


def _run_cli_export(monkeypatch, capsys, ledger_path, fmt):
    from zn_gate import cli as cli_mod
    import zn_gate.evidence as evidence_mod

    monkeypatch.setattr(evidence_mod, "EVIDENCE_FILE", str(ledger_path))
    args = argparse.Namespace(verify=False, export=True, format=fmt, output=None)
    assert cli_mod.cmd_evidence(args) == 0
    return capsys.readouterr().out


def test_cli_export_jsonl_matches_node_bytes(tmp_path, monkeypatch, capsys):
    ledger = tmp_path / "evidence.jsonl"
    text = "".join(json.dumps(r) + "\n" for r in _FIXED_RECORDS)
    ledger.write_text(text, encoding="utf-8")

    out = _run_cli_export(monkeypatch, capsys, ledger, "jsonl")

    assert out == text
    assert not out.endswith("\n\n")


def test_cli_export_csv_matches_node_bytes(tmp_path, monkeypatch, capsys):
    ledger = tmp_path / "evidence.jsonl"
    ledger.write_text("".join(json.dumps(r) + "\n" for r in _FIXED_RECORDS), encoding="utf-8")
    expected = (
        _CSV_HEADER + "\n"
        + f'"2026-01-01T00:00:00Z","allow","tool-call","bash","agent-a","","","{"a" * 64}","{"b" * 64}","{GENESIS_HASH}","15"\n'
        + f'"2026-01-01T00:00:01Z","block","tool-call","bash","agent-b","path:sensitive_file","says ""no""","{"c" * 64}","{"d" * 64}","{"b" * 64}","20"\n'
    )

    out = _run_cli_export(monkeypatch, capsys, ledger, "csv")

    assert out == expected
    assert not out.endswith("\n\n")


def test_cli_export_missing_ledger_prints_nothing_for_jsonl(tmp_path, monkeypatch, capsys):
    missing = tmp_path / "missing.jsonl"

    assert _run_cli_export(monkeypatch, capsys, missing, "jsonl") == ""
    assert _run_cli_export(monkeypatch, capsys, missing, "csv") == _CSV_HEADER + "\n"
