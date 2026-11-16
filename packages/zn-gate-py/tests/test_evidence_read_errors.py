"""Exact error texts when the evidence log cannot be read, in a temporary folder."""
import json
import sys

import pytest

from zn_gate.evidence import (
    EvidenceLedgerError,
    get_last_hash,
    verify_evidence_ledger,
)


def _cannot_read_text():
    # The text comes from the OS error: open() on a directory is EISDIR on Linux and macOS,
    # but PermissionError ("Permission denied") on Windows.
    reason = "Permission denied" if sys.platform == "win32" else "Is a directory"
    return "Cannot read the evidence log: " + reason


def test_invalid_utf8_in_last_line(tmp_path):
    p = tmp_path / "evidence.jsonl"
    p.write_bytes(b'{"a": 1}\n\xff\xfe\n')
    with pytest.raises(EvidenceLedgerError) as exc:
        get_last_hash(str(p))
    assert str(exc.value) == (
        "Invalid UTF-8 bytes in the last line (byte 0): the log was corrupted or modified."
    )


def test_last_line_is_not_json(tmp_path):
    p = tmp_path / "evidence.jsonl"
    p.write_text("not json\n", encoding="utf-8")
    with pytest.raises(EvidenceLedgerError) as exc:
        get_last_hash(str(p))
    try:
        json.loads("not json")
    except ValueError as e:
        expected = f"Malformed JSON in the last line: {e}"
    assert str(exc.value) == expected
    assert str(exc.value) == "Malformed JSON in the last line: Expecting value: line 1 column 1 (char 0)"


def test_log_that_cannot_be_opened(tmp_path):
    # A directory in place of the log file cannot be opened for reading.
    p = tmp_path / "evidence.jsonl"
    p.mkdir()
    with pytest.raises(EvidenceLedgerError) as exc:
        get_last_hash(str(p))
    assert str(exc.value) == _cannot_read_text()
    result = verify_evidence_ledger(str(p))
    assert result["valid"] is False
    assert result["error"] == _cannot_read_text()
