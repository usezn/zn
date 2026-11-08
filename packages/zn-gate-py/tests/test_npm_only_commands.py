"""Commands that exist only in the npm package say where they are."""
import sys

import pytest

from zn_gate import cli


@pytest.mark.parametrize("argv", [["hooks", "install", "claude-code"], ["init"], ["doctor"], ["unlock"]])
def test_npm_only_command_points_to_npm(monkeypatch, capsys, argv):
    monkeypatch.setattr(sys, "argv", ["zn-gate"] + argv)
    assert cli.main() == 2
    out = capsys.readouterr()
    assert out.out == ""
    assert f"zn-gate {argv[0]} is in the npm package" in out.err
    assert "npx -y zn-gate init" in out.err
    assert "Traceback" not in out.err


def test_python_commands_still_work(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["zn-gate", "test", "hello"])
    cli.main()
    assert "npm package" not in capsys.readouterr().err
