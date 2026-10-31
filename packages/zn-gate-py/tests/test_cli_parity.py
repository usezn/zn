"""The Python CLI redirects npm-only commands and uses the documented exit codes."""
import sys

import pytest

from zn_gate import __version__, cli


def _run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["zn-gate", *argv])
    return cli.main()


@pytest.mark.parametrize("cmd", ["report", "reach", "connect", "disconnect", "uninstall"])
def test_npm_only_command_names_the_exact_command(monkeypatch, capsys, cmd):
    assert _run(monkeypatch, cmd) == 2
    out = capsys.readouterr()
    assert out.out == ""
    assert f"npx -y zn-gate {cmd}" in out.err
    assert "npm install -g zn-gate" in out.err
    assert "Traceback" not in out.err


def test_version_command_matches_flag(monkeypatch, capsys):
    assert _run(monkeypatch, "version") == 0
    printed = capsys.readouterr().out.strip()
    assert printed.startswith(f"zn-gate {__version__}")
    with pytest.raises(SystemExit) as exc:
        _run(monkeypatch, "--version")
    assert exc.value.code == 0
    assert capsys.readouterr().out.strip() == printed


def test_unknown_command_exits_1(monkeypatch, capsys):
    assert _run(monkeypatch, "bogus") == 1
    err = capsys.readouterr().err
    assert "Unknown command: bogus" in err
    assert "zn-gate --help" in err


def test_scan_missing_path_exits_1(monkeypatch, tmp_path, capsys):
    assert _run(monkeypatch, "scan", str(tmp_path / "nope")) == 1


@pytest.mark.parametrize("flag", ["-v", "-V"])
def test_short_version_flags_match_npm(monkeypatch, capsys, flag):
    with pytest.raises(SystemExit) as exc:
        _run(monkeypatch, "--version")
    assert exc.value.code == 0
    expected = capsys.readouterr().out.strip()
    with pytest.raises(SystemExit) as exc:
        _run(monkeypatch, flag)
    assert exc.value.code == 0
    assert capsys.readouterr().out.strip() == expected


def test_every_subcommand_is_a_known_command(monkeypatch, capsys):
    known = cli.known_commands(cli.build_parser())
    assert {"test", "analyze", "scan", "evidence", "status", "stats"} <= known
    for cmd in sorted(known):
        monkeypatch.setattr(sys, "argv", ["zn-gate", cmd, "--help"])
        with pytest.raises(SystemExit) as exc:
            cli.main()
        assert exc.value.code == 0
        assert "Unknown command" not in capsys.readouterr().err


def test_help_points_to_npm_help(monkeypatch, capsys):
    assert _run(monkeypatch, "help") == 2
    out = capsys.readouterr()
    assert out.out == ""
    assert "npx -y zn-gate --help" in out.err
    assert "Unknown command" not in out.err
    assert "Traceback" not in out.err


@pytest.mark.parametrize("argv", [["stats", "share"], ["stats", "share", "show"]])
def test_stats_share_points_to_npm(monkeypatch, capsys, argv):
    assert _run(monkeypatch, *argv) == 2
    out = capsys.readouterr()
    assert out.out == ""
    assert "zn-gate stats share is a command of the npm package" in out.err
    assert "npx -y zn-gate stats share" in out.err
    assert "unrecognized arguments" not in out.err
    assert "Traceback" not in out.err
