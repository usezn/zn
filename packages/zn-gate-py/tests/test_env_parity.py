import json
import os
import subprocess
import sys

import pytest

from zn_gate.env import is_verbose, debug_enabled, zn_home


@pytest.mark.parametrize("v", ["1", "true", "TRUE", "Yes", "on", " On "])
def test_verbose_on(v):
    assert is_verbose({"ZN_VERBOSE": v}) is True


@pytest.mark.parametrize("v", [None, "", "0", "false", "no", "off", "maybe"])
def test_verbose_off(v):
    env = {} if v is None else {"ZN_VERBOSE": v}
    assert is_verbose(env) is False


def test_debug_enabled():
    assert debug_enabled({"DEBUG": "1"}) is True
    assert debug_enabled({"ZN_VERBOSE": "0"}) is False


def test_zn_home_redirects_evidence(tmp_path):
    home = tmp_path / "zh"
    assert zn_home({"ZN_HOME": str(home)}) == os.path.abspath(str(home))
    code = ("from zn_gate import evidence, stats;"
            "evidence.log_evidence({'agent':'t','phase':'pre_tool','verdict':'allow','tool_name':'t'});"
            "print(evidence.EVIDENCE_FILE);print(stats.stats_file())")
    env = dict(os.environ, ZN_HOME=str(home), HOME=str(tmp_path / "fake"), USERPROFILE=str(tmp_path / "fake"))
    r = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    ev, st = r.stdout.split()
    assert ev == os.path.join(os.path.abspath(str(home)), "evidence.jsonl")
    assert os.path.dirname(ev) == os.path.dirname(st)
    assert os.path.exists(ev)
