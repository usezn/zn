"""Spellings of the destructive commands that a shell (bash, PowerShell or cmd.exe) reads the same way as the plain
form: ANSI-C quoting, default-value expansion, brace lists, PowerShell parameter, variable and call-operator forms,
cmd.exe rd forms, a download written into a startup file through a glued redirect, a group or an exec descriptor, a
download run from a group, eval or env -S, interpreters fed by a substitution, chmod modes with leading zeros or
symbolic clauses, fork bomb variants, text that echo, printf or a here-string feeds into a shell, globs that can
name a protected folder, device or program (rm -rf /us?, /usr/bin/r? -rf ~, dd of=/dev/sd?), and paths that climb
out of the home folder and back down into a project (~/../alice/proj/build stays allowed).

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
    "a chmod mode with many leading zeros": "chmod -R " + "0" * 20000 + "x /home/alice",
    "a chmod mode with a long run of +": "chmod -R " + "+" * 20000 + "Z ~",
    "many symbolic chmod clauses": "chmod -R " + "o+w," * 5000 + "o-w ~",
    "a long function name": "a" * 20000 + "(){ x; }",
    "many function keywords": "function f " * 2000 + "{ f|f& }",
    "many function heads with no body": "f() " * 7000 + "{",
    "a function body that never closes": "f(){ " + "f|f& " * 5000,
    "a long function body": "f(){ " + "f|" * 10000 + "f& }; f",
    "separators after a function body": "f(){ f|f& }" + ";" * 20000 + "g",
    "printf with many arguments into a shell": "printf '%s%s' " + "a " * 10000 + "| sh",
    "printf with a long format reused into a shell": "printf '" + "x" * 2000 + "%s' " + "a " * 10000 + "| sh",
    "printf with a run of zeros in a conversion": "printf '%" + "0" * 20000 + "Z' | sh",
    "echo with many words into a shell": "echo " + "w " * 20000 + "| sh",
    "a long here-string": "sh <<< '" + "rm " * 7000 + "'",
    "many echo commands in a substitution": 'bash -c "$(' + "echo x; " * 3000 + ')"',
    "an unclosed substitution in sh -c": 'bash -c "$(' + "x" * 20000 + '"',
    "a long glob in an rm path": "rm -rf /" + "*?" * 10000,
    "many classes in an rm path": "rm -rf /" + "[a-z]" * 4000,
    "many unclosed classes": "rm -rf /" + "[" * 20000,
    "many class names in one class": "rm -rf /[" + "[:alpha:]" * 2200 + "]",
    "many ranges in one class": "rm -rf /[" + "a-b" * 6600 + "]",
    "many short globs": "rm -rf " + " ".join("/*" + format(i, "x") for i in range(3000)),
    "many glob words with three segments": "chmod -R 777 " + " ".join("/h*/[a-z]%d" % i for i in range(2000)),
    "a long glob program name": "/usr/bin/" + "*" * 20000 + " -rf /home/alice",
    "a long glob device": "dd if=/dev/zero of=/dev/" + "[s]" * 6600,
    "a long climb above the home folder": "rm -rf ~/" + "../" * 6600 + "x",
}


@pytest.mark.parametrize("name", sorted(LONG))
def test_long_input_stays_fast(name):
    t0 = time.perf_counter()
    check_command(LONG[name])
    assert time.perf_counter() - t0 < 3.0, name
