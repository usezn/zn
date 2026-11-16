"""Unit tests for evidence._build_record (fake events only)."""
import hashlib
import json
import re

from zn_gate.evidence import GENESIS_HASH, _build_record, _canonical


def test_id_format():
    rec = _build_record({}, GENESIS_HASH)
    assert re.fullmatch(r"ev_[0-9a-f]+_[0-9a-f]{8}", rec["id"])


def test_defaults():
    rec = _build_record({}, GENESIS_HASH)
    assert rec["agent_environment"] == "python-agent"
    assert rec["phase"] == "tool-call"
    assert rec["tool_name"] == "unknown"
    assert rec["verdict"] == "allow"
    assert rec["engine"] == "python-deterministic"
    assert rec["rule"] is None
    assert rec["reason"] is None
    assert rec["latency_us"] == 0


def test_string_payload_hash():
    rec = _build_record({"payload": "hello example"}, GENESIS_HASH)
    assert rec["payload_sha256"] == hashlib.sha256(b"hello example").hexdigest()


def test_dict_payload_hash_uses_compact_json():
    payload = {"a": 1, "b": ["x", "y"]}
    rec = _build_record({"payload": payload}, GENESIS_HASH)
    expected = hashlib.sha256(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    assert rec["payload_sha256"] == expected


def test_preview_is_cut_at_120_characters():
    rec = _build_record({"payload": "a" * 300}, GENESIS_HASH)
    assert rec["payload_preview"] == "a" * 120


def test_whole_number_confidence_stays_int():
    rec = _build_record({"confidence": 1.0}, GENESIS_HASH)
    assert rec["confidence"] == 1
    assert isinstance(rec["confidence"], int)
    assert isinstance(_build_record({"confidence": 0.5}, GENESIS_HASH)["confidence"], float)


def test_prev_hash_is_copied_unchanged():
    prev = "ab" * 32
    assert _build_record({}, prev)["prev_hash"] == prev


def test_record_hash_matches_recomputation():
    prev = "cd" * 32
    rec = _build_record({"tool_name": "example_tool", "payload": {"k": "v"}}, prev)
    body = {k: v for k, v in rec.items() if k != "record_hash"}
    expected = hashlib.sha256(f"{prev}:{_canonical(body)}".encode("utf-8")).hexdigest()
    assert rec["record_hash"] == expected
