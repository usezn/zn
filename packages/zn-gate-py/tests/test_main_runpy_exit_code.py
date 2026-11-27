"""`python -m zn_gate` passes the CLI exit code through to the process.

Run in-process with runpy so coverage traces zn_gate/__main__.py; a subprocess
would not be measured.
"""
import runpy
import sys

import pytest


def _run_as_main(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["zn-gate", *argv])
    with pytest.raises(SystemExit) as info:
        runpy.run_module("zn_gate.__main__", run_name="__main__", alter_sys=True)
    return info.value.code


def test_version_exits_with_0(monkeypatch):
    assert _run_as_main(monkeypatch, "--version") == 0


def test_unknown_command_exits_with_1(monkeypatch, capsys):
    assert _run_as_main(monkeypatch, "frobnicate") == 1
    assert "Unknown command: frobnicate" in capsys.readouterr().err


@pytest.mark.parametrize("code", [2, 3])
def test_whatever_cli_main_returns_becomes_the_exit_code(monkeypatch, code):
    import zn_gate.cli

    monkeypatch.setattr(zn_gate.cli, "main", lambda: code)
    assert _run_as_main(monkeypatch, "scan") == code
