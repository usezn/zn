"""Build tools under the destructive-command policy: make and cargo build commands stay allowed, and a
make clean whose path variable points at the filesystem root should be refused. The Python policy has no
make rule (it only covers rm, find, chmod, dd and the other shapes in destructive.py), so the root case is
recorded as an expected failure until a rule exists. Fake values only; nothing is executed."""

import pytest

from zn_gate import check_command


def test_build_tools_are_allowed():
    for cmd in ["make", "make test", "cargo build", "cargo build --release"]:
        res = check_command(cmd)
        assert res.verdict == "allow", cmd
        assert res.rule == "none", cmd


def test_make_clean_without_a_root_path_is_allowed():
    res = check_command("make clean")
    assert res.verdict == "allow"
    assert res.rule == "none"


@pytest.mark.xfail(
    strict=True,
    reason="gap: the Python policy has no make rule, so make clean with PREFIX=/ or DESTDIR=/ is allowed; "
    "add a rule (and the Node twin) before removing this marker",
)
def test_make_clean_with_a_root_path_variable_is_blocked():
    for cmd in ["make clean PREFIX=/", "make clean DESTDIR=/"]:
        res = check_command(cmd)
        assert res.verdict == "block", cmd
        assert res.rule.startswith("destructive:"), cmd
