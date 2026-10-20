"""A file that cannot be read after the first checks is reported, and text in UTF-16 without a byte order mark is scanned."""
import argparse
import io
import json
import os
import shutil
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import pytest

from zn_gate import cli
from zn_gate.cli import cmd_scan

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"


def _run(path, fmt="json"):
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = cmd_scan(argparse.Namespace(path=str(path), exclude=None, include=None, format=fmt, no_fail=False))
    return rc, buf.getvalue()


def test_read_failure_is_not_scanned_json_and_text(tmp_path):
    (tmp_path / "ok.md").write_text("hello\n", encoding="utf-8")
    (tmp_path / "bad.md").write_text("hello\n", encoding="utf-8")
    real = Path.read_bytes

    def flaky(self):
        if self.name == "bad.md":
            raise PermissionError("denied")
        return real(self)

    with mock.patch.object(Path, "read_bytes", flaky):
        _, out = _run(tmp_path)
        _, text = _run(tmp_path, "text")
    data = json.loads(out)
    assert data["total_files"] == 1
    assert data["total_skipped"] == 1
    assert data["skipped"][0]["file"].endswith("bad.md")
    assert data["skipped"][0]["reason"] == "cannot be read"
    assert "Scanned 1 files" in text and "Not scanned (1)" in text and "cannot be read" in text


@pytest.mark.parametrize("codec", ["utf-16-le", "utf-16-be"])
def test_bomless_utf16_env_is_scanned(tmp_path, codec):
    (tmp_path / ".env").write_bytes(f"AWS_ACCESS_KEY_ID={FAKE_AWS}\n".encode(codec))
    rc, out = _run(tmp_path)
    data = json.loads(out)
    assert rc == 1
    assert any(v["type"] == "secret_leak" for v in data["threats"])
    assert FAKE_AWS not in out


def test_unclear_utf16_is_not_scanned(tmp_path):
    raw = b"A\x00\x00B" * 50
    (tmp_path / "x.txt").write_bytes(raw)
    rc, out = _run(tmp_path)
    data = json.loads(out)
    assert data["total_files"] == 0
    assert data["skipped"][0]["reason"] == "unclear text encoding"


def test_plain_utf8_and_binary_unchanged():
    assert cli._utf16_without_bom(b"hello world") is None
    assert cli._utf16_without_bom(b"\x89PNG\r\n\x1a\n" + bytes(range(1, 255)) * 4) is None
