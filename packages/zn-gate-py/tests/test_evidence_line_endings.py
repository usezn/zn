"""Line endings of the evidence ledger and its exports.

The ledger is a hash chain and the Node package writes it with \\n only, so the Python package
must write the same bytes on Linux, macOS and Windows, and an export keeps the endings the
log has (a ledger that arrives with \\r\\n still verifies)."""
import json
from zn_gate.evidence import export_evidence_ledger, log_evidence, verify_evidence_ledger


def _write_events(path, n=3):
    for i in range(n):
        log_evidence({"agent": "a", "tool_name": "t", "verdict": "allow", "payload": f"p{i}"}, file_path=str(path))


def test_ledger_is_written_with_lf_only(tmp_path):
    p = tmp_path / "evidence.jsonl"
    _write_events(p)
    raw = p.read_bytes()
    assert b"\r" not in raw
    assert raw.endswith(b"\n") and raw.count(b"\n") == 3


def test_jsonl_export_is_the_ledger_bytes_with_lf_only(tmp_path):
    p = tmp_path / "evidence.jsonl"
    _write_events(p)
    r = export_evidence_ledger(str(p))
    assert r["valid"] is True
    assert r["content"].encode("utf-8") == p.read_bytes()
    assert "\r" not in r["content"]


def test_appending_to_a_log_without_final_newline_uses_lf(tmp_path):
    p = tmp_path / "evidence.jsonl"
    _write_events(p, 1)
    p.write_bytes(p.read_bytes().rstrip(b"\n"))
    _write_events(p, 1)
    assert b"\r" not in p.read_bytes()
    assert verify_evidence_ledger(str(p))["valid"] is True


def test_crlf_ledger_still_verifies_and_its_endings_are_kept(tmp_path):
    p = tmp_path / "evidence.jsonl"
    _write_events(p)
    lf = p.read_bytes()
    crlf = lf.replace(b"\n", b"\r\n")
    p.write_bytes(crlf)
    check = verify_evidence_ledger(str(p))
    assert check["valid"] is True and check["total"] == 3
    r = export_evidence_ledger(str(p))
    assert r["valid"] is True
    assert r["content"].encode("utf-8") == crlf  # kept as it is, like the Node package


def test_appending_to_a_crlf_ledger_adds_lf_records_and_keeps_the_chain(tmp_path):
    p = tmp_path / "evidence.jsonl"
    _write_events(p, 2)
    p.write_bytes(p.read_bytes().replace(b"\n", b"\r\n"))
    _write_events(p, 1)
    raw = p.read_bytes()
    assert raw.count(b"\r\n") == 2 and raw.endswith(b"}\n") and not raw.endswith(b"\r\n")
    check = verify_evidence_ledger(str(p))
    assert check["valid"] is True and check["total"] == 3
    assert json.loads(raw.split(b"\n")[-2])["prev_hash"] == json.loads(raw.split(b"\n")[1])["record_hash"]
