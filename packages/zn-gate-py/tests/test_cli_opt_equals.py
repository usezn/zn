"""scan and analyze take --option=value and --option value, in the Python CLI and in the Node CLI alike."""
import os
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
    env = dict(os.environ, PYTHONPATH=str(SRC), NO_COLOR="1", ZN_LOCAL_ONLY="true")
    return subprocess.run(
        [*cmd, *args], capture_output=True, text=True, env=env, timeout=60
    )


def _node(*args):
    return _run([NODE, str(NODE_CLI)], *args)


def _py(*args):
    return _run([sys.executable, "-m", "zn_gate.cli"], *args)


@pytest.mark.parametrize("run", [_node, _py], ids=["node", "python"])
def test_scan_equals_form_matches_spaced_form(run, tmp_path):
    (tmp_path / "notes.md").write_text("A harmless note with no instructions.\n")
    spaced = run("scan", "--format", "json", str(tmp_path))
    equals = run("scan", "--format=json", str(tmp_path))
    assert equals.returncode == spaced.returncode, equals.stderr
    assert equals.stdout == spaced.stdout
    assert "give the value" not in equals.stderr
    assert "unknown option" not in equals.stderr


@pytest.mark.parametrize("run", [_node, _py], ids=["node", "python"])
def test_scan_empty_equals_value_matches_empty_spaced_value(run, tmp_path):
    (tmp_path / "notes.md").write_text("A harmless note with no instructions.\n")
    spaced = run("scan", "--include", "", str(tmp_path))
    equals = run("scan", "--include=", str(tmp_path))
    assert equals.returncode == spaced.returncode, equals.stderr
    assert equals.stdout == spaced.stdout
