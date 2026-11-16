"""Next steps without Node.js: the Python CLI prints the npx form only when node and npx are
both found, and otherwise prints a step that the Python package can follow alone."""
import shutil
import sys

import pytest

from zn_gate.shell_names import npx_name
from zn_gate import cli, mcp_secrets
from zn_gate.node_tools import node_available

FAKE_VALUE = "ZNTESTFAKE-not-a-real-value"
PRIVATE_KEY_STEP = ("Next: move the key out of this file (for example to ~/.ssh or a secret manager) "
                    "and replace it if the file was ever committed or shared.")


def _only(*found):
    """A stand-in for shutil.which that finds only the named programs."""
    def which(name, *args, **kwargs):
        return "/usr/bin/" + name if name in found else None
    return which


@pytest.fixture
def real_check(monkeypatch):
    """Use the real check instead of the default one set in conftest.py."""
    monkeypatch.setattr(cli, "node_available", node_available)
    monkeypatch.setattr(mcp_secrets, "node_available", node_available)


def _run(monkeypatch, capsys, *argv):
    monkeypatch.setattr(sys, "argv", ["zn-gate", *argv])
    code = cli.main()
    return code, capsys.readouterr()


def test_node_available_needs_both_node_and_npx(monkeypatch):
    monkeypatch.setattr(shutil, "which", _only("node", "npx"))
    assert node_available() is True
    monkeypatch.setattr(shutil, "which", _only("node"))
    assert node_available() is False
    monkeypatch.setattr(shutil, "which", _only("npx"))
    assert node_available() is False
    monkeypatch.setattr(shutil, "which", _only())
    assert node_available() is False


# ---- scan: the next step for a finding

def test_scan_step_with_node_keeps_the_npx_form(monkeypatch, real_check):
    monkeypatch.setattr(shutil, "which", _only("node", "npx"))
    step = cli._leak_next_step(".env", "secret:generic")
    assert step.startswith("Next: run " + npx_name() + " -y zn-gate env shadow .env to move the values into the local vault, ")
    step = cli._leak_next_step("a.txt", "secret:generic")
    assert step.startswith("Next: run " + npx_name() + " -y zn-gate secret set NAME to store the value in the local vault")


@pytest.mark.parametrize("name, rule", [(".env", "secret:generic"), ("a.txt", "secret:generic"),
                                        ("config.yaml", "secret:aws_access_key")])
def test_scan_step_without_node_has_no_npx(monkeypatch, real_check, name, rule):
    monkeypatch.setattr(shutil, "which", _only())
    step = cli._leak_next_step(name, rule)
    assert step.startswith("Next: take the value out of this file")
    assert "environment variable" in step
    assert "Node.js" in step
    assert "npx" not in step
    assert "env shadow" not in step and "secret set" not in step
    assert FAKE_VALUE not in step


def test_scan_private_key_step_is_the_same_either_way(monkeypatch, real_check):
    monkeypatch.setattr(shutil, "which", _only())
    assert cli._leak_next_step("id_rsa", "secret:private_key") == PRIVATE_KEY_STEP
    monkeypatch.setattr(shutil, "which", _only("node", "npx"))
    assert cli._leak_next_step("id_rsa", "secret:private_key") == PRIVATE_KEY_STEP


# ---- MCP config: the next step for a secret in a server definition

def test_mcp_step_with_node_keeps_the_npx_form(monkeypatch, real_check):
    monkeypatch.setattr(shutil, "which", _only("node", "npx"))
    step = mcp_secrets.mcp_next_step("environment variable", "BRAVE_API_KEY")
    assert npx_name() + " -y zn-gate secret set BRAVE_API_KEY" in step


def test_mcp_step_without_node_has_no_npx(monkeypatch, real_check):
    monkeypatch.setattr(shutil, "which", _only())
    step = mcp_secrets.mcp_next_step("environment variable", "BRAVE_API_KEY")
    assert "npx" not in step
    assert "set it as an environment variable" in step
    assert "Node.js" in step
    assert FAKE_VALUE not in step


# ---- npm-only commands: messages and exit codes

def test_npm_only_message_with_node_names_the_npx_init(monkeypatch, real_check):
    monkeypatch.setattr(shutil, "which", _only("node", "npx"))
    msg = cli.npm_only_message("report")
    assert msg.startswith("zn-gate report is in the npm package")
    assert "  " + npx_name() + " -y zn-gate init" in msg.splitlines()


def test_npm_only_message_without_node_has_no_npx(monkeypatch, real_check):
    monkeypatch.setattr(shutil, "which", _only())
    msg = cli.npm_only_message("report")
    assert msg.startswith("zn-gate report is in the npm package")
    assert "npx" not in msg
    assert "https://nodejs.org" in msg
    assert msg.endswith("\n")


def test_npm_only_simple_message_without_node_has_no_npx(monkeypatch, real_check):
    monkeypatch.setattr(shutil, "which", _only())
    msg = cli.npm_only_simple_message("connect")
    assert msg.splitlines()[0] == "zn-gate connect is a command of the npm package, not of this Python package."
    assert "npx" not in msg
    assert "https://nodejs.org" in msg


def test_npm_help_message_without_node_points_to_python_help(monkeypatch, real_check):
    monkeypatch.setattr(shutil, "which", _only())
    msg = cli.npm_help_message()
    assert "npx" not in msg
    assert "  zn-gate --help" in msg.splitlines()


def test_report_command_without_node(monkeypatch, capsys, real_check):
    monkeypatch.setattr(shutil, "which", _only())
    code, out = _run(monkeypatch, capsys, "report")
    assert code == 2
    assert out.out == ""
    assert "npx" not in out.err
    assert "Traceback" not in out.err


def test_help_command_without_node(monkeypatch, capsys, real_check):
    monkeypatch.setattr(shutil, "which", _only())
    code, out = _run(monkeypatch, capsys, "help")
    assert code == 2
    assert "zn-gate --help" in out.err
    assert "npx" not in out.err


def test_plain_help_flag_works_without_node(monkeypatch, capsys, real_check):
    monkeypatch.setattr(shutil, "which", _only())
    monkeypatch.setattr(sys, "argv", ["zn-gate", "--help"])
    with pytest.raises(SystemExit) as exc:
        cli.main()
    assert exc.value.code == 0
    assert "npx" not in capsys.readouterr().out
