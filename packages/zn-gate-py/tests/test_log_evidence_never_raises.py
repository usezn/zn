"""log_evidence never raises for a log problem, and an event it cannot write as JSON is refused
with a warning (Node's logEvidence returns null in the same cases). Values json cannot write are
written the way the Node package's JSON.stringify writes them: bytes as a Buffer object, a set as
an empty object. Every record written here must still verify."""
import hashlib
import json

import pytest

from zn_gate import evidence
from zn_gate.evidence import log_evidence, verify_evidence_ledger


@pytest.fixture(autouse=True)
def _reset_warning(monkeypatch):
    monkeypatch.setattr(evidence, "_last_warn", None)
    monkeypatch.setattr(evidence, "_last_write_warn", None)


def _records(path):
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def test_bytes_tool_name_is_written_as_a_buffer_object(tmp_path):
    p = tmp_path / "e.jsonl"
    rec = log_evidence({"tool_name": b"x"}, str(p))
    assert rec is not None
    assert rec["tool_name"] == {"type": "Buffer", "data": [120]}
    assert _records(p)[0]["tool_name"] == {"type": "Buffer", "data": [120]}
    assert verify_evidence_ledger(str(p))["valid"]


def test_object_reason_is_written_as_text_and_verifies(tmp_path):
    p = tmp_path / "e.jsonl"
    rec = log_evidence({"reason": object(), "tool_name": "t"}, str(p))
    assert rec is not None
    assert isinstance(rec["reason"], str) and rec["reason"].startswith("<object object")
    assert verify_evidence_ledger(str(p))["valid"]


def test_nested_unserialisable_rule_is_written_and_verifies(tmp_path):
    p = tmp_path / "e.jsonl"
    rec = log_evidence({"rule": {"ids": {1, 2}, "raw": b"\x00"}}, str(p))
    assert rec is not None
    assert rec["rule"] == {"ids": {}, "raw": {"type": "Buffer", "data": [0]}}
    assert verify_evidence_ledger(str(p))["valid"]


def test_set_payload_hashes_as_empty_object_like_node(tmp_path):
    p = tmp_path / "e.jsonl"
    rec = log_evidence({"payload": {"a", "b"}}, str(p))
    assert rec is not None
    # Node's JSON.stringify(new Set(...)) is "{}", so the payload digest is the one for "{}".
    assert rec["payload_sha256"] == hashlib.sha256(b"{}").hexdigest()
    assert rec["payload_preview"] == "{}"
    assert verify_evidence_ledger(str(p))["valid"]


def test_bytes_payload_is_written_as_a_buffer_object(tmp_path):
    p = tmp_path / "e.jsonl"
    rec = log_evidence({"payload": b"ab"}, str(p))
    assert rec is not None
    text = '{"type":"Buffer","data":[97,98]}'
    assert rec["payload_sha256"] == hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert verify_evidence_ledger(str(p))["valid"]


def test_serialisable_values_are_written_unchanged(tmp_path):
    p = tmp_path / "e.jsonl"
    rec = log_evidence({"payload": {"k": [1, 2.5, None]}, "rule": "R1", "confidence": 0.5}, str(p))
    assert rec is not None
    assert rec["payload_preview"] == '{"k":[1,2.5,null]}'
    assert rec["rule"] == "R1"
    assert verify_evidence_ledger(str(p))["valid"]


def test_none_event_returns_none_with_a_warning(tmp_path, capsys):
    p = tmp_path / "e.jsonl"
    assert log_evidence(None, str(p)) is None
    err = capsys.readouterr().err
    assert "not a mapping" in err and "NoneType" in err
    assert not p.exists() or p.read_text(encoding="utf-8") == ""


def test_list_event_returns_none_with_a_warning(tmp_path, capsys):
    p = tmp_path / "e.jsonl"
    assert log_evidence(["tool_name", "x"], str(p)) is None
    assert "list, not a mapping" in capsys.readouterr().err


def test_circular_payload_is_refused_and_the_chain_is_unchanged(tmp_path, capsys):
    p = tmp_path / "e.jsonl"
    assert log_evidence({"tool_name": "ok"}, str(p)) is not None
    before = p.read_text(encoding="utf-8")

    loop = {}
    loop["self"] = loop
    assert log_evidence({"payload": loop}, str(p)) is None
    assert "cannot be written as JSON" in capsys.readouterr().err

    assert p.read_text(encoding="utf-8") == before
    # The next good event continues the same chain.
    assert log_evidence({"tool_name": "next"}, str(p)) is not None
    result = verify_evidence_ledger(str(p))
    assert result["valid"] and result["total"] == 2


def test_circular_base_field_is_refused_with_a_warning(tmp_path, capsys):
    p = tmp_path / "e.jsonl"
    loop = []
    loop.append(loop)
    assert log_evidence({"rule": loop}, str(p)) is None
    assert "cannot be written as JSON" in capsys.readouterr().err
    assert not p.exists() or p.read_text(encoding="utf-8") == ""


def test_warning_is_throttled_across_refused_events(tmp_path, capsys):
    p = tmp_path / "e.jsonl"
    for _ in range(3):
        assert log_evidence(None, str(p)) is None
    assert capsys.readouterr().err.count("not a mapping") == 1
