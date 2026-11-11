"""The shape of the result that the ledger check returns for a corrupted ledger."""
import json

from zn_gate import evidence
from zn_gate.evidence import _corrupt_result, log_evidence, verify_evidence_ledger


def test_keys_and_values_with_fake_numbers():
    r = _corrupt_result(7, 3, "example error")
    assert set(r) == {"valid", "total", "verified", "broken_index", "error"}
    assert r == {"valid": False, "total": 7, "verified": 3, "broken_index": 3, "error": "example error"}


def test_verified_always_equals_broken_index():
    for total, index in [(0, 0), (1, 0), (10, 9)]:
        r = _corrupt_result(total, index, "x")
        assert r["verified"] == r["broken_index"] == index
        assert r["total"] == total


def test_error_text_is_kept_unchanged():
    text = "Line 2: é odd text, 100% \"quoted\""
    assert _corrupt_result(2, 1, text)["error"] == text
    assert _corrupt_result(2, 1, "")["error"] == ""


def test_result_is_json_serialisable():
    r = _corrupt_result(5, 2, "bad")
    assert json.loads(json.dumps(r)) == r


def test_non_object_line_carries_line_number_text(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    log_evidence({"payload": "example-0", "tool_name": "bash"}, file_path=p)
    with open(p, "ab") as f:
        f.write(b"[1, 2]\n")
    r = verify_evidence_ledger(p)
    assert r["valid"] is False
    assert r["total"] == 2
    assert r["broken_index"] == 1 == r["verified"]
    assert r["error"] == "Malformed record at line 2: not a JSON object."


def test_unreadable_ledger_reports_zero_total_and_index(tmp_path, monkeypatch):
    p = str(tmp_path / "evidence.jsonl")
    log_evidence({"payload": "example-0", "tool_name": "bash"}, file_path=p)

    def boom(_path):
        raise evidence.EvidenceLedgerError("Cannot read the evidence log: example")

    monkeypatch.setattr(evidence, "_read_ledger", boom)
    r = verify_evidence_ledger(p)
    assert r == {
        "valid": False,
        "total": 0,
        "verified": 0,
        "broken_index": 0,
        "error": "Cannot read the evidence log: example",
    }
