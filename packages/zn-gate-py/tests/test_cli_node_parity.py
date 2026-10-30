"""The Python CLI and the Node CLI agree on the version and on basic exit codes."""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

NODE = shutil.which("node")
NODE_CLI = Path(__file__).resolve().parents[2] / "zn-gate" / "bin" / "cli.js"
SRC = Path(__file__).resolve().parents[1] / "src"

pytestmark = pytest.mark.skipif(
    NODE is None or not NODE_CLI.is_file(), reason="Node CLI not available"
)


def _run(cmd, *args):
    env = dict(os.environ, PYTHONPATH=str(SRC), NO_COLOR="1")
    return subprocess.run(
        [*cmd, *args], capture_output=True, text=True, env=env, timeout=60
    )


def _node(*args):
    return _run([NODE, str(NODE_CLI)], *args)


def _py(*args):
    return _run([sys.executable, "-m", "zn_gate.cli"], *args)


def test_version_starts_with_the_same_name_and_number():
    node, py = _node("--version"), _py("--version")
    assert node.returncode == py.returncode == 0
    pattern = r"zn-gate \d+\.\d+\.\d+"
    node_head = re.match(pattern, node.stdout)
    py_head = re.match(pattern, py.stdout)
    assert node_head and py_head
    assert node_head.group(0) == py_head.group(0)


@pytest.mark.parametrize("flag", ["--help", "-h"])
def test_help_exits_0_in_both(flag):
    assert _node(flag).returncode == 0
    assert _py(flag).returncode == 0


def test_unknown_command_has_the_same_message():
    # Same text. The exit code is 1 in Node and 2 (wrong usage) in Python:
    # see "Exit codes" in docs/cli.md.
    node, py = _node("bogus"), _py("bogus")
    assert node.returncode == 1
    assert py.returncode == 2
    assert node.stderr == py.stderr
    assert "Unknown command: bogus" in py.stderr
