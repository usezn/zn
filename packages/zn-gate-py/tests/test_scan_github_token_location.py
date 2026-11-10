"""zn-gate scan text output names the file, the line and the rule of a GitHub
token, and never prints the token itself. The token is invented and built at
runtime."""
import argparse

from zn_gate import cli

# Matches gh[pousr]_[A-Za-z0-9]{36,40}: a ghp_ prefix and 36 characters.
FAKE_GH = "ghp_" + "ZNFAKE" * 6


def test_text_scan_reports_file_line_and_rule_of_github_token(tmp_path, capsys):
    lines = ["# notes", "first filler line", "token: " + FAKE_GH, "last filler line"]
    (tmp_path / "notes.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="")
    ns = argparse.Namespace(path=str(tmp_path), format="text", no_fail=True, allow_partial=False,
                            include=None, exclude=None)
    cli.cmd_scan(ns)
    out = capsys.readouterr().out
    assert "notes.md:3 Secret found [secret:github_token]" in out
    assert "[REDACTED_GITHUB_TOKEN]" in out
    assert FAKE_GH not in out
