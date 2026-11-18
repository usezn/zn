"""The evidence verify, stats and export of earlier versions, which read the whole log into memory.

Kept only as the reference the streaming versions are compared with (test_evidence_streaming_read.py).
"""
import hashlib
import json
import os
from typing import Any, Dict, List, Optional

from zn_gate.evidence import (
    EVIDENCE_FILE,
    GENESIS_HASH,
    EvidenceLedgerError,
    _canonical_forms,
    _corrupt_result,
    _is_cut_tail,
    _read_ledger,
    _truncated_tail_result,
)


def ref_verify(file_path: str = EVIDENCE_FILE) -> Dict[str, Any]:
    """
    Verifies the cryptographic integrity of the entire ledger chain from genesis.
    Returns { "valid": bool, "total": int, "verified": int, "broken_index": Optional[int], "error": Optional[str] }
    """
    if not os.path.exists(file_path):
        return {"valid": True, "total": 0, "verified": 0, "broken_index": None, "error": None}

    try:
        lines, bad = _read_ledger(file_path)
    except EvidenceLedgerError as e:
        return _corrupt_result(0, 0, str(e))

    expected_prev = GENESIS_HASH

    for i, line in enumerate(lines):
        if i in bad:
            return _corrupt_result(len(lines), i, bad[i])
        try:
            rec = json.loads(line)
        except Exception as e:
            if i == len(lines) - 1 and _is_cut_tail(file_path, line):
                return _truncated_tail_result(len(lines), i)
            return {
                "valid": False,
                "total": len(lines),
                "verified": i,
                "broken_index": i,
                "error": f"Malformed JSON at line {i+1}: {e}",
            }
        if not isinstance(rec, dict):
            return _corrupt_result(len(lines), i, f"Malformed record at line {i+1}: not a JSON object.")

        rec_prev = rec.get("prev_hash")
        if rec_prev != expected_prev:
            return {
                "valid": False,
                "total": len(lines),
                "verified": i,
                "broken_index": i,
                "error": f"Broken chain link at line {i+1} (record {rec.get('id')}): expected {expected_prev[:8]}... found {str(rec_prev)[:8]}...",
            }

        recorded_hash = rec.get("record_hash")
        base_record = {k: v for k, v in rec.items() if k != "record_hash"}
        # Ensure confidence preserves whole number integer representation if whole
        if "confidence" in base_record and isinstance(base_record["confidence"], (int, float)) and float(base_record["confidence"]).is_integer():
            base_record["confidence"] = int(base_record["confidence"])

        # Records written by the Node package or an older version may differ in how non-ASCII
        # text is written: accept both canonical forms.
        # Called only within this iteration, before expected_prev is reassigned.
        def _hash_of(text: str) -> str:
            return hashlib.sha256(f"{expected_prev}:{text}".encode("utf-8", errors="replace")).hexdigest()  # noqa: B023

        if recorded_hash not in {_hash_of(text) for text in _canonical_forms(base_record)}:
            return {
                "valid": False,
                "total": len(lines),
                "verified": i,
                "broken_index": i,
                "error": f"Tamper detected at line {i+1} (record {rec.get('id')}): hash mismatch! Log contents were modified.",
            }

        expected_prev = recorded_hash

    return {"valid": True, "total": len(lines), "verified": len(lines), "broken_index": None, "error": None}


def ref_stats(file_path: str = EVIDENCE_FILE, limit: int = 50) -> Dict[str, Any]:
    """Generates aggregated stats from the evidence ledger."""
    if not os.path.exists(file_path):
        return {
            "total": 0,
            "blocks": 0,
            "allows": 0,
            "shadows": 0,
            "valid": True,
            "top_rules": {},
            "top_tools": {},
            "recent": [],
        }

    try:
        lines, bad = _read_ledger(file_path)
    except EvidenceLedgerError as e:
        return {"total": 0, "blocks": 0, "allows": 0, "shadows": 0, "valid": False, "error": str(e),
                "top_rules": {}, "top_tools": {}, "recent": []}

    blocks = 0
    allows = 0
    shadows = 0
    top_rules: Dict[str, int] = {}
    top_tools: Dict[str, int] = {}
    recent: List[Dict[str, Any]] = []

    for line in reversed(lines):
        try:
            rec = json.loads(line)
            if not isinstance(rec, dict):
                continue
            v = rec.get("verdict")
            if v == "block":
                blocks += 1
                r = rec.get("rule")
                if r:
                    top_rules[r] = top_rules.get(r, 0) + 1
            elif v == "shadow":
                shadows += 1
            else:
                allows += 1

            t = rec.get("tool_name")
            if t:
                top_tools[t] = top_tools.get(t, 0) + 1

            if len(recent) < limit:
                recent.append(rec)
        except Exception:
            continue

    check = ref_verify(file_path)

    return {
        "total": len(lines),
        "blocks": blocks,
        "allows": allows,
        "shadows": shadows,
        "valid": check["valid"],
        "error": check.get("error"),
        "top_rules": top_rules,
        "top_tools": top_tools,
        "recent": recent,
    }


def ref_export(file_path: Optional[str] = None, format: str = "jsonl") -> Dict[str, Any]:
    """
    Exports the evidence ledger into JSONL or CSV with cryptographic verification.
    Suitable for enterprise compliance audits (SOC 2, ISO 27001, EU AI Act Art. 12).
    """
    target_path = file_path if file_path else EVIDENCE_FILE
    norm_format = "csv" if (format or "jsonl").lower() == "csv" else "jsonl"

    if not os.path.exists(target_path):
        empty_content = (
            "timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us\n"
            if norm_format == "csv"
            else ""
        )
        return {
            "content": empty_content,
            "format": norm_format,
            "valid": True,
            "tip_hash": GENESIS_HASH,
            "total": 0,
        }

    verify_result = ref_verify(target_path)
    try:
        lines, _bad = _read_ledger(target_path)
    except EvidenceLedgerError:
        lines = []

    tip_hash = GENESIS_HASH
    if lines:
        try:
            tip_hash = json.loads(lines[-1]).get("record_hash", GENESIS_HASH)
        except Exception:
            pass

    if norm_format == "csv":
        headers = [
            "timestamp",
            "verdict",
            "phase",
            "tool_name",
            "agent_environment",
            "rule",
            "reason",
            "payload_sha256",
            "record_hash",
            "prev_hash",
            "latency_us",
        ]
        rows = [",".join(headers)]
        for line in lines:
            try:
                obj = json.loads(line)
                row_vals = []
                for h in headers:
                    val = str(obj.get(h, "")) if obj.get(h) is not None else ""
                    escaped = val.replace('"', '""')
                    row_vals.append(f'"{escaped}"')
                rows.append(",".join(row_vals))
            except Exception:
                pass

        return {
            "content": "\n".join(rows) + "\n",
            "format": "csv",
            "valid": verify_result["valid"],
            "error": verify_result.get("error"),
            "tip_hash": tip_hash,
            "total": len(lines),
        }

    try:
        with open(target_path, "rb") as f:
            # Same line endings as reading in text mode (Windows writes CRLF).
            raw = f.read().decode("utf-8", errors="replace").replace("\r\n", "\n")
    except OSError:
        raw = ""

    return {
        "content": raw if raw.endswith("\n") else raw + "\n",
        "format": "jsonl",
        "valid": verify_result["valid"],
        "error": verify_result.get("error"),
        "tip_hash": tip_hash,
        "total": len(lines),
    }
