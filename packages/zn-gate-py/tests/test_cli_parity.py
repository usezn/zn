"""The Python CLI redirects npm-only commands and uses the documented exit codes."""
import sys

import pytest

from zn_gate import __version__, cli


def _run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["zn-gate", *argv])
    return cli.main()


@pytest.mark.parametrize("cmd", ["report", "reach", "connect", "disconnect"])
def test_npm_only_command_names_the_exact_command(monkeypatch, capsys, cmd):
    assert _run(monkeypatch, cmd) == 2
    out = capsys.readouterr()
    assert out.out == ""
    assert f"npx -y zn-gate {cmd}" in out.err
    assert f"npm install -g zn-gate" in out.err
    assert "Traceback" not in out.err


def test_version_command_matches_flag(monkeypatch, capsys):
    assert _run(monkeypatch, "version") == 0
    printed = capsys.readouterr().out.strip()
    assert printed.startswith(f"zn-gate {__version__}")
    with pytest.raises(SystemExit) as exc:
        _run(monkeypatch, "--version")
    assert exc.value.code == 0
    assert capsys.readouterr().out.strip() == printed


def test_unknown_command_exits_2(monkeypatch, capsys):
    assert _run(monkeypatch, "bogus") == 2
    err = capsys.readouterr().err
    assert "Unknown command: bogus" in err
    assert "zn-gate --help" in err


def test_scan_missing_path_exits_2(monkeypatch, tmp_path, capsys):
    assert _run(monkeypatch, "scan", str(tmp_path / "nope")) == 2
