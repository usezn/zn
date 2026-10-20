"""Plain-language wording of common CLI messages (same text as the Node CLI)."""
import argparse
import json

from zn_gate import cli


def _scan(path, fmt="text"):
    ns = argparse.Namespace(path=str(path), format=fmt, no_fail=False, include=None, exclude=None)
    return cli.cmd_scan(ns)


def test_missing_path_has_example(tmp_path, capsys):
    assert _scan(tmp_path / "nope") == 2
    err = capsys.readouterr().err
    assert "Error: Target path does not exist" in err
    assert "Example: zn-gate scan ." in err


def test_secret_reason_is_plain(tmp_path, capsys):
    (tmp_path / "a.txt").write_text("key = AKIA" + "IOSFODNN7" + "EXAMPLE\n", encoding="utf-8")
    _scan(tmp_path, "json")
    out = capsys.readouterr().out
    assert "DLP" not in out
    assert "A real-looking secret is stored in plain text here" in out
    json.loads(out)


def test_tamper_text_is_plain(monkeypatch, capsys):
    monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: {"valid": False, "error": "bad link"})
    code = cli.cmd_evidence(type("A", (), {"verify": True})())
    assert code == 1
    err = capsys.readouterr().err
    assert "The evidence log was changed or damaged, so its checks no longer match: bad link" in err
    assert "Tamper detected" not in err
