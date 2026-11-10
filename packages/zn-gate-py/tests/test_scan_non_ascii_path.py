"""zn-gate scan finds a secret in a file whose folder and file names contain
non-ASCII characters, and reports that path as written. The key is the AWS
documentation example key, which the repository's gitleaks config allows."""
import argparse

from zn_gate import cli

FAKE_AWS = "AKIAIOSFODNN7EXAMPLE"


def test_text_scan_reports_file_under_non_ascii_path(tmp_path, capsys):
    folder = tmp_path / "configuración"
    folder.mkdir()
    (folder / "clé.env").write_text("AWS_ACCESS_KEY_ID=" + FAKE_AWS + "\n", encoding="utf-8", newline="")
    ns = argparse.Namespace(path=str(tmp_path), format="text", no_fail=True, allow_partial=False,
                            include=None, exclude=None)
    cli.cmd_scan(ns)
    out = capsys.readouterr().out
    assert "clé.env" in out
    assert "configuración" in out
    assert "secret:aws_access_key" in out
    assert FAKE_AWS not in out
