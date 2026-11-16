"""Spellings of the destructive commands that a shell (bash, PowerShell or cmd.exe) reads the same way as the plain
form: ANSI-C quoting, default-value expansion, brace lists, PowerShell parameter, variable and call-operator forms,
cmd.exe rd forms, a download written into a startup file through a glued redirect, a group or an exec descriptor, a
download run from a group, eval or env -S, and interpreters fed by a substitution.

The cases are shared with the Node tests: packages/zn-gate/test/fixtures/destructive_spelling_forms.json. Each case
must get the rule in `expect`; the look-alikes that only touch a project folder must stay allowed. Only fake paths and
example.com URLs; the strings are only read, never run."""

import json
import os
import time

import pytest

from zn_gate.destructive import check_command

_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "zn-gate", "test", "fixtures", "destructive_spelling_forms.json"
)
if not os.path.exists(_PATH):
    pytest.skip("the Node package's fixtures are not next to this package", allow_module_level=True)
with open(_PATH, encoding="utf-8") as fh:
    CASES = json.load(fh)["cases"]


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


def test_shared_list_has_both_kinds():
    assert sum(1 for c in CASES if c["expect"] != "allow") >= 100
    assert sum(1 for c in CASES if c["expect"] == "allow") >= 40


@pytest.mark.parametrize("case", CASES, ids=["%s-%03d" % (c["family"], i) for i, c in enumerate(CASES)])
def test_spelling(case):
    assert rule(case["cmd"]) == case["expect"], case["cmd"]


def test_many_default_expansions_stay_bounded():
    words = " ".join("${V%d:-x%d}" % (i, i) for i in range(40))
    assert rule("echo " + words) == "allow"
    assert rule("rm -rf " + words + " ${LAST:-/home/alice}") == "rm_root_home"


def test_brace_list_that_expands_too_far_is_refused():
    assert rule("rm -rf " + "{a,b}" * 12) == "too_many_commands"
    assert rule("echo " + "{a,b}" * 12) == "allow"


# Long inputs aimed at the patterns that once backtracked: each must be read in a few seconds at most.
LONG = {
    "iex then a run of (": "iex " + "(" * 20000,
    "iex then a run of ( with blanks": "iex " + "( " * 20000,
    "a run of >": "curl x" + ">" * 20000,
    "rd with a run of /s": "rd " + "/s" * 10000 + "x C:\\ ",
    "many default values": "rm -rf " + " ".join("${V%d:-x}" % i for i in range(3000)),
    "nested script blocks": "& " + "{ " * 10000 + "Remove-Item",
    "many groups around a download": "{ curl x; " * 2000 + "}" * 2000 + " | sh",
    "start with many options": "start " + "/b " * 7000 + "x",
    "many exec descriptors": "; ".join("exec %d>> ./f" % (i % 9) for i in range(3000)),
}


@pytest.mark.parametrize("name", sorted(LONG))
def test_long_input_stays_fast(name):
    t0 = time.perf_counter()
    check_command(LONG[name])
    assert time.perf_counter() - t0 < 3.0, name
