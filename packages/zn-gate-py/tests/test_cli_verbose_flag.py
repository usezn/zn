"""--verbose is accepted by analyze, scan and status in the Python CLI, as in the npm package."""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
NODE = shutil.which("node")
NODE_CLI = Path(__file__).resolve().parents[2] / "zn-gate" / "bin" / "cli.js"


def _env(home, **extra):
    env = dict(os.environ, PYTHONPATH=str(SRC), NO_COLOR="1", HOME=home, USERPROFILE=home, ZN_LOCAL_ONLY="true")
    env.pop("ZN_VERBOSE", None)
    env.pop("DEBUG", None)
    env.update(extra)
    return env


def _py(home, *args):
    return subprocess.run([sys.executable, "-m", "zn_gate.cli", *args], capture_output=True, text=True,
                          env=_env(home), timeout=60, input="")


@pytest.fixture()
def home():
    with tempfile.TemporaryDirectory() as d:
        yield d


@pytest.mark.parametrize("args", [
    ["analyze", "hello there", "--verbose"],
    ["status", "--verbose"],
])
def test_verbose_is_accepted(home, args):
    r = _py(home, *args)
    assert r.returncode == 0, r.stderr
    assert "unrecognized arguments" not in r.stderr


def test_scan_accepts_verbose(home):
    folder = Path(home) / "docs"
    folder.mkdir()
    (folder / "a.md").write_text("hello\n")
    r = _py(home, "scan", str(folder), "--verbose")
    assert r.returncode == 0, r.stderr
    assert "unrecognized arguments" not in r.stderr


def test_verbose_sets_the_zn_verbose_switch(monkeypatch):
    from zn_gate import cli
    from zn_gate.verbose import is_verbose
    monkeypatch.delenv("ZN_VERBOSE", raising=False)
    monkeypatch.delenv("DEBUG", raising=False)
    monkeypatch.setattr(sys, "argv", ["zn-gate", "status", "--verbose"])
    monkeypatch.setattr(cli, "cmd_status", lambda args: 0)
    assert cli.main() == 0
    assert is_verbose()
    monkeypatch.delenv("ZN_VERBOSE", raising=False)


def test_without_the_flag_verbose_stays_off(monkeypatch):
    from zn_gate import cli
    from zn_gate.verbose import is_verbose
    monkeypatch.delenv("ZN_VERBOSE", raising=False)
    monkeypatch.delenv("DEBUG", raising=False)
    monkeypatch.setattr(sys, "argv", ["zn-gate", "status"])
    monkeypatch.setattr(cli, "cmd_status", lambda args: 0)
    assert cli.main() == 0
    assert not is_verbose()


def test_other_commands_still_reject_it(home):
    r = _py(home, "check", "--verbose")
    assert r.returncode == 2


@pytest.mark.skipif(NODE is None or not NODE_CLI.is_file(), reason="Node CLI not available")
@pytest.mark.parametrize("args", [
    ["analyze", "hello there", "--verbose"],
    ["status", "--verbose"],
])
def test_same_exit_code_as_node(home, args):
    node = subprocess.run([NODE, str(NODE_CLI), *args], capture_output=True, text=True,
                          env=_env(home), timeout=60, input="")
    py = _py(home, *args)
    assert node.returncode == py.returncode == 0, (node.stderr, py.stderr)
