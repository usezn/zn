"""Direct tests for the ledger reader and the corruption result helper."""
import pytest

from zn_gate.evidence import EvidenceLedgerError, _corrupt_result, _read_ledger


def test_blank_and_whitespace_only_lines_are_skipped(tmp_path):
    p = tmp_path / "evidence.jsonl"
    p.write_bytes(b'{"a": 1}\n\n   \n\t\r\n{"b": 2}\n  \n')
    lines, bad = _read_ledger(str(p))
    assert lines == ['{"a": 1}', '{"b": 2}']
    assert bad == {}


def test_empty_file_has_no_lines(tmp_path):
    p = tmp_path / "evidence.jsonl"
    p.write_bytes(b"")
    assert _read_ledger(str(p)) == ([], {})


def test_invalid_utf8_is_reported_by_one_based_line_number(tmp_path):
    p = tmp_path / "evidence.jsonl"
    p.write_bytes(b'{"a": 1}\n\n{"b": "\xff\xfe"}\n{"c": 3}\n')
    lines, bad = _read_ledger(str(p))
    assert len(lines) == 3
    assert list(bad) == [1]
    assert "line 2" in bad[1]
    assert "byte 7" in bad[1]
    assert "�" in lines[1]


def test_invalid_utf8_on_the_first_line(tmp_path):
    p = tmp_path / "evidence.jsonl"
    p.write_bytes(b'\xc3\x28\n{"a": 1}\n')
    lines, bad = _read_ledger(str(p))
    assert len(lines) == 2
    assert list(bad) == [0]
    assert "line 1" in bad[0]
    assert "byte 0" in bad[0]


def test_missing_file_raises_ledger_error(tmp_path):
    with pytest.raises(EvidenceLedgerError):
        _read_ledger(str(tmp_path / "missing.jsonl"))


def test_corrupt_result_shape():
    result = _corrupt_result(5, 2, "Invalid UTF-8 bytes at line 3")
    assert result["valid"] is False
    assert result["total"] == 5
    assert result["verified"] == 2
    assert result["broken_index"] == 2
    assert result["error"] == "Invalid UTF-8 bytes at line 3"
