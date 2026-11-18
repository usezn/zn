"""No decision in the package rests on an assert: python -O removes asserts, so a check written as one
would vanish. The checks that were asserts are explicit now; this runs them with and without -O and
expects the same answer. Fake text only."""
import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
PROBE = Path(__file__).with_name("_assert_probe.py")


def _run(*flags):
    env = dict(os.environ, PYTHONPATH=str(SRC), PYTHONDONTWRITEBYTECODE="1")
    done = subprocess.run([sys.executable, *flags, str(PROBE)], capture_output=True, text=True, env=env, timeout=120)
    assert done.returncode == 0, done.stderr
    return dict(line.split(" ", 1) for line in done.stdout.splitlines())


def test_the_package_source_has_no_assert_statement():
    found = []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        found += [f"{path.relative_to(SRC)}:{node.lineno}" for node in ast.walk(tree) if isinstance(node, ast.Assert)]
    assert found == [], "an assert is removed by python -O; use an explicit check: " + ", ".join(found)


def test_the_probe_really_runs_without_asserts_under_dash_o():
    assert _run()["debug"] == "True"
    assert _run("-O")["debug"] == "False"


@pytest.mark.parametrize(
    "name",
    ["js_number_not_finite", "backslash_run_missing", "word_run_missing", "value_filter_without_value"],
)
def test_an_impossible_state_still_stops_the_work_under_dash_o(name):
    normal, optimised = _run(), _run("-O")
    # An explicit error, not a silent pass and not a vague AttributeError or TypeError.
    assert optimised[name] in ("ValueError", "RuntimeError"), optimised[name]
    assert optimised[name] == normal[name]


def test_the_honest_cases_give_the_same_answer_under_dash_o():
    normal, optimised = _run(), _run("-O")
    assert normal["js_number"] == optimised["js_number"] == "1.5"
    assert normal["kv"] == optimised["kv"]
    assert normal["kv"] != "[]"
