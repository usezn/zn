"""Edge cases of the evidence log tail reader (_read_last_line)."""

import os

from zn_gate.evidence import _read_last_line


def _write(tmp_path, data: bytes) -> str:
    p = tmp_path / "evidence.jsonl"
    p.write_bytes(data)
    return str(p)


def test_no_final_newline(tmp_path):
    assert _read_last_line(_write(tmp_path, b'{"a":1}\n{"b":2}')) == b'{"b":2}'


def test_single_line_without_newline(tmp_path):
    assert _read_last_line(_write(tmp_path, b'{"a":1}')) == b'{"a":1}'


def test_crlf_endings(tmp_path):
    assert _read_last_line(_write(tmp_path, b'{"a":1}\r\n{"b":2}\r\n')) == b'{"b":2}'


def test_last_line_longer_than_read_buffer(tmp_path):
    long_line = b'{"v":"' + b"x" * 200_000 + b'"}'
    path = _write(tmp_path, b'{"a":1}\n' + long_line + b"\n")
    assert _read_last_line(path) == long_line


def test_long_line_is_only_line(tmp_path):
    long_line = b'{"v":"' + b"y" * 150_000 + b'"}'
    assert _read_last_line(_write(tmp_path, long_line)) == long_line


def test_only_blank_lines(tmp_path):
    assert _read_last_line(_write(tmp_path, b"\n  \r\n\t\n\n")) is None


def test_empty_file(tmp_path):
    assert _read_last_line(_write(tmp_path, b"")) is None


def test_trailing_blank_lines_are_skipped(tmp_path):
    assert _read_last_line(_write(tmp_path, b'{"a":1}\n\n  \n\r\n')) == b'{"a":1}'


def test_file_shrinks_while_read(tmp_path, monkeypatch):
    path = _write(tmp_path, b'{"a":1}\n{"b":2}\n' + b" " * 100)
    real_open = open

    class Shrinking:
        def __init__(self, f):
            self._f = f

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self._f.close()
            return False

        def seek(self, *args):
            pos = self._f.seek(*args)
            if args == (0, os.SEEK_END):
                # The file is cut right after its size was measured.
                with real_open(path, "r+b") as w:
                    w.truncate(16)
            return pos

        def read(self, n):
            return self._f.read(n)

    monkeypatch.setattr("zn_gate.evidence.open", lambda p, m: Shrinking(real_open(p, m)), raising=False)
    assert _read_last_line(path) == b'{"b":2}'
