"""The ledger tail reader returns the last non-empty line of a file as bytes, reading only the
end of the file. It trims spaces, tabs and CR around the line, and skips trailing blank lines."""
import os

import pytest

from zn_gate.evidence import EvidenceLedgerError, _read_last_line

# The first read window of _read_last_line is 64 KiB; lines around that size exercise the
# window doubling and the case where the window starts in the middle of a line.
WINDOW = 65536


def _write(tmp_path, data: bytes) -> str:
    path = os.path.join(str(tmp_path), "ledger.jsonl")
    with open(path, "wb") as f:
        f.write(data)
    return path


def test_empty_file_has_no_last_line(tmp_path):
    assert _read_last_line(_write(tmp_path, b"")) is None


def test_whitespace_only_file_has_no_last_line(tmp_path):
    assert _read_last_line(_write(tmp_path, b" \t\r\n\n  \r\n")) is None


def test_single_line_with_trailing_newline(tmp_path):
    assert _read_last_line(_write(tmp_path, b'{"record_hash": "a"}\n')) == b'{"record_hash": "a"}'


def test_single_line_without_trailing_newline(tmp_path):
    assert _read_last_line(_write(tmp_path, b'{"record_hash": "a"}')) == b'{"record_hash": "a"}'


def test_returns_only_the_last_of_several_lines(tmp_path):
    assert _read_last_line(_write(tmp_path, b"first\nsecond\nthird\n")) == b"third"


def test_last_line_longer_than_the_first_window(tmp_path):
    last = b"x" * (3 * WINDOW + 17)
    assert _read_last_line(_write(tmp_path, b"short\n" + last + b"\n")) == last


def test_file_without_any_newline_longer_than_the_window(tmp_path):
    data = b"y" * (2 * WINDOW + 5)
    assert _read_last_line(_write(tmp_path, data)) == data


@pytest.mark.parametrize("size", [WINDOW - 1, WINDOW, WINDOW + 1, 2 * WINDOW, 2 * WINDOW + 1])
def test_last_line_around_window_boundaries(tmp_path, size):
    last = b"z" * size
    assert _read_last_line(_write(tmp_path, b"head\n" + last + b"\n")) == last


def test_crlf_line_endings(tmp_path):
    assert _read_last_line(_write(tmp_path, b"a\r\nb\r\n")) == b"b"


def test_crlf_single_line_without_newline_keeps_no_carriage_return(tmp_path):
    assert _read_last_line(_write(tmp_path, b"only\r")) == b"only"


def test_trailing_blank_lines_are_skipped(tmp_path):
    assert _read_last_line(_write(tmp_path, b"a\nb\n\n\n")) == b"b"


def test_trailing_blank_lines_with_spaces_and_tabs_are_skipped(tmp_path):
    assert _read_last_line(_write(tmp_path, b"a\nb\n  \n\t\r\n \n")) == b"b"


def test_leading_and_trailing_spaces_on_the_last_line_are_trimmed(tmp_path):
    assert _read_last_line(_write(tmp_path, b"a\n   b\t \n")) == b"b"


def test_last_line_that_is_blank_after_a_long_block_of_blank_lines(tmp_path):
    # Blank lines wider than one window: the reader must keep going back to find the content.
    data = b"content\n" + b"\n" * (WINDOW + 100)
    assert _read_last_line(_write(tmp_path, data)) == b"content"


def test_non_utf8_bytes_are_returned_unchanged(tmp_path):
    # The reader does not decode: the caller decides what invalid UTF-8 means.
    raw = b"ok\n\xff\xfe{\"a\": 1}"
    assert _read_last_line(_write(tmp_path, raw)) == b"\xff\xfe{\"a\": 1}"


def test_missing_file_raises_ledger_error(tmp_path):
    missing = os.path.join(str(tmp_path), "nope.jsonl")
    with pytest.raises(EvidenceLedgerError, match="Cannot read the evidence log"):
        _read_last_line(missing)


def test_directory_instead_of_file_raises_ledger_error(tmp_path):
    with pytest.raises(EvidenceLedgerError):
        _read_last_line(str(tmp_path))
