"""A log that an editor re-saved (leading UTF-8 byte order mark, Windows line endings) is told
apart from a real edit. verify never changes the file."""
import argparse
import io
import contextlib
import os

import pytest

from zn_gate import evidence
from zn_gate.evidence import log_evidence, verify_evidence_ledger

BOM = b"\xef\xbb\xbf"


def _crlf(b):
    return b.replace(b"\n", b"\r\n")


def _bom(b):
    return BOM + b


def _edit(b):
    return b.replace(b"example-1", b"example-X")


CASES = {
    "bom_only": (_bom, "reencoded"),
    "bom_and_crlf": (lambda b: _bom(_crlf(b)), "reencoded"),
    "crlf_only": (_crlf, "valid"),
    "real_edit": (_edit, "tamper"),
    "real_edit_and_bom": (lambda b: _bom(_edit(b)), "tamper"),
    "real_edit_bom_crlf": (lambda b: _bom(_crlf(_edit(b))), "tamper"),
}


def _ledger(tmp_path):
    path = str(tmp_path / "evidence.jsonl")
    for i in range(3):
        log_evidence({"payload": f"example-{i}", "tool_name": "bash"}, path)
    return path


@pytest.mark.parametrize("name", list(CASES))
def test_verify_resaved(tmp_path, name):
    make, kind = CASES[name]
    path = _ledger(tmp_path)
    with open(path, "rb") as f:
        data = make(f.read())
    with open(path, "wb") as f:
        f.write(data)
    v = verify_evidence_ledger(path)
    with open(path, "rb") as f:
        assert f.read() == data, "verify must not change the file"
    if kind == "valid":
        assert v["valid"] is True
        assert v.get("crlf") is True
        assert "reencoded" not in v
    elif kind == "reencoded":
        assert v["valid"] is False
        assert v["reencoded"] is True
        assert v["total"] == 3
        assert "byte order mark" in v["error"]
        assert "line 1" in v["error"]
        assert "Tamper" not in v["error"]
    else:
        assert v["valid"] is False
        assert "reencoded" not in v
        assert "Tamper detected at line 2" in v["error"]


@pytest.mark.parametrize("name", list(CASES))
def test_cli_verify_resaved(tmp_path, monkeypatch, capsys, name):
    from zn_gate import cli

    make, kind = CASES[name]
    path = _ledger(tmp_path)
    with open(path, "rb") as f:
        data = make(f.read())
    with open(path, "wb") as f:
        f.write(data)
    monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: verify_evidence_ledger(path))
    monkeypatch.setattr(cli, "reencoded_hint", lambda: evidence.reencoded_hint(path))
    code = cli.cmd_evidence(argparse.Namespace(verify=True))
    out = capsys.readouterr()
    text = out.out + out.err
    with open(path, "rb") as f:
        assert f.read() == data
    if kind == "valid":
        assert code == 0
        assert "Windows line endings (CRLF)" in text
    elif kind == "reencoded":
        assert code == 1
        assert "LOG WAS RE-SAVED BY AN EDITOR" in text
        assert "byte order mark" in text
        assert "tail -c +4" in text or "ReadAllBytes" in text
        assert "Tamper detected" not in text
    else:
        assert code == 1
        assert "Tamper detected" in text
        assert "RE-SAVED" not in text
