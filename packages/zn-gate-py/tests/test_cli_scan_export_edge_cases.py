"""Edge cases of the zn-gate CLI and command check that no other test pins:
a file holding only a UTF-8 byte order mark, safe read-only shell commands,
and an unknown export format for the evidence ledger. Only invented values."""

import argparse
import json
import sys

import pytest

from zn_gate import check_command, cli


def _scan_json(path, capsys):
    ns = argparse.Namespace(path=str(path), format="json", no_fail=False, include=None, exclude=None)
    code = cli.cmd_scan(ns)
    return code, json.loads(capsys.readouterr().out)


def test_scan_file_with_only_a_utf8_bom_is_clean(tmp_path, capsys):
    (tmp_path / "bom.txt").write_bytes(b"\xef\xbb\xbf")
    code, data = _scan_json(tmp_path, capsys)
    assert code == 0
    assert data["total_files"] == 1
    assert data["threats"] == []
    assert data["skipped"] == []


@pytest.mark.parametrize("command", ["ls", "cat README.md", "echo hello"])
def test_safe_read_only_commands_are_allowed(command):
    res = check_command(command)
    assert res.verdict == "allow"
    assert res.allowed is True
    assert res.rule == "none"


def test_evidence_export_unknown_format_exits_2(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["zn-gate", "evidence", "--export", "--format", "xml"])
    with pytest.raises(SystemExit) as e:
        cli.main()
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert "xml" in err
    assert "jsonl" in err and "csv" in err
