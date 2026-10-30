"""Plain-words errors when the Python CLI cannot write an evidence export."""

import argparse
import contextlib
import io
import json
import os
from unittest import mock

import pytest

from zn_gate import cli

needs_non_root = pytest.mark.skipif(
    not hasattr(os, "geteuid") or os.geteuid() == 0,
    reason="needs a non-root POSIX account (root ignores file modes)",
)

EMPTY_HASH = "0" * 64
GOOD = {"content": '{"x": 1}\n', "format": "jsonl", "valid": True, "tip_hash": EMPTY_HASH, "total": 1}
EMPTY = {"content": "", "format": "jsonl", "valid": True, "tip_hash": EMPTY_HASH, "total": 0}


def _export(output, res=GOOD):
    ns = argparse.Namespace(verify=False, export=True, format="jsonl", output=output)
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(cli, "export_evidence_ledger", return_value=res), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.cmd_evidence(ns)
    return code, out.getvalue(), err.getvalue()


def _scan_ns(path):
    return argparse.Namespace(path=str(path), format="text", no_fail=False, allow_partial=False,
                              include=None, exclude=None)


# ---- B-2242: export write failures

def test_export_into_missing_folder_is_a_plain_message(tmp_path):
    target = tmp_path / "no-such-folder" / "out.jsonl"
    code, out, err = _export(str(target))  # must not raise a traceback
    assert code == 1
    assert out == ""
    assert "Traceback" not in err
    assert str(target) in err
    assert "does not exist" in err and "Create the folder" in err


@needs_non_root
def test_export_into_read_only_folder_is_a_plain_message(tmp_path):
    folder = tmp_path / "ro"
    folder.mkdir()
    folder.chmod(0o500)
    target = folder / "out.jsonl"
    try:
        code, out, err = _export(str(target))
    finally:
        folder.chmod(0o700)
    assert code == 1
    assert "Traceback" not in err
    assert str(target) in err
    assert "not allowed to read or change" in err and "Check who owns it" in err
    assert not target.exists()


def test_successful_export_to_a_file_is_unchanged(tmp_path):
    target = tmp_path / "out.jsonl"
    code, out, err = _export(str(target))
    assert code == 0
    assert target.read_text(encoding="utf-8") == GOOD["content"]
    assert "Exported 1 records" in out and err == ""
