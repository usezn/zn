"""Plain-words errors in the Python CLI: export write failures, and the next step
in the empty-export, unreadable-file and missing-path messages, `test` on a path, and
`analyze` output."""

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


# ---- export write failures

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


# ---- next steps and empty export

def test_empty_export_to_stdout_says_what_to_do_next():
    code, out, err = _export(None, EMPTY)
    assert code == 0
    assert out.strip() == ""
    assert "no evidence records yet" in err and "zn-gate test" in err


def test_empty_export_to_a_file_says_what_to_do_next(tmp_path):
    code, out, err = _export(str(tmp_path / "empty.jsonl"), EMPTY)
    assert code == 0
    assert "Exported 0 records" in out
    assert "zn-gate test" in err


def test_missing_scan_path_names_the_next_step(tmp_path, capsys):
    assert cli.cmd_scan(_scan_ns(tmp_path / "nope.txt")) == 1
    err = capsys.readouterr().err
    assert err.count("\n") == 1  # still one line
    assert "target path not found" in err and "Check the spelling" in err


@needs_non_root
def test_unreadable_file_gets_a_next_step_in_the_text_report(tmp_path):
    secret = tmp_path / "notes.txt"
    secret.write_text("hello\n")
    secret.chmod(0)
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            code = cli.cmd_scan(_scan_ns(tmp_path))
    finally:
        secret.chmod(0o600)
    text = out.getvalue()
    assert code == 3
    assert "cannot be read" in text
    assert "Next step:" in text and "read access" in text


def test_test_on_an_existing_path_says_it_checks_text(tmp_path):
    f = tmp_path / "file.txt"
    f.write_text("nothing here\n")
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.cmd_test(argparse.Namespace(text=str(f), json=False))
    assert code == 0
    assert "ALLOW" in out.getvalue()
    assert "checks the text you typed, not the file" in err.getvalue()
    assert "zn-gate scan" in err.getvalue()


def test_test_on_plain_text_prints_no_note():
    err = io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
        cli.cmd_test(argparse.Namespace(text="Please summarize the report", json=False))
    assert err.getvalue() == ""


# ---- analyze prints JSON, and the flag is accepted

@pytest.mark.parametrize("flags", [{}, {"json": True}, {"json": False}])
def test_analyze_always_prints_json(flags):
    fake = {"verdict": "allow", "confidence": 0.99, "engine": "oss-local"}
    ns = argparse.Namespace(text="hi", key=None, stage=None, url=None, local_only=True,
                            long_input=None, **flags)
    out = io.StringIO()
    with mock.patch.object(cli, "analyze", return_value=dict(fake)), contextlib.redirect_stdout(out):
        code = cli.cmd_analyze(ns)
    assert code == 0
    assert json.loads(out.getvalue())["verdict"] == "allow"


def test_analyze_parser_defaults_to_json_and_accepts_the_flag():
    parser = cli.build_parser()
    assert parser.parse_args(["analyze", "hi"]).json is False
    assert parser.parse_args(["analyze", "--json", "hi"]).json is True
