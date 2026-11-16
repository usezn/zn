"""The message for the 'help' word names the npm help command and the Node.js version."""
import sys

from zn_gate import cli
from zn_gate.shell_names import npx_name


def test_message_names_the_npm_help_command():
    assert npx_name() + " -y zn-gate --help" in cli.npm_help_message()


def test_message_mentions_node_18():
    assert "Node.js 18" in cli.npm_help_message()


def test_message_ends_with_one_newline():
    text = cli.npm_help_message()
    assert text.endswith("\n")
    assert not text.endswith("\n\n")


def test_cli_prints_the_message_for_help_with_exit_code_2(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["zn-gate", "help"])
    assert cli.main() == 2
    out = capsys.readouterr()
    assert out.out == ""
    assert out.err == cli.npm_help_message()
