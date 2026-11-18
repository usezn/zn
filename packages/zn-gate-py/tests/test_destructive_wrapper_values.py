"""A wrapper option that takes a value (nice --adjustment 10, stdbuf --output L, flock --wait 5) and a timeout duration
written the way GNU timeout reads it (inf, 1e3, +5, 0x10) do not hide the command behind them. Mirrors
packages/zn-gate/test/destructive_wrapper_values.test.js and reads the same cases
(packages/zn-gate/test/fixtures/wrapper_value_cases.json). Only the text is checked: nothing is run."""
import json
import time
from pathlib import Path

import pytest

from zn_gate import destructive
from zn_gate.destructive import check_command

FIXTURE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "wrapper_value_cases.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


def test_fixture_is_not_empty():
    assert len(CASES) >= 60


@pytest.mark.parametrize("case", CASES, ids=[c["cmd"] for c in CASES])
def test_shared_wrapper_case(case):
    assert rule(case["cmd"]) == case["rule"]


@pytest.mark.parametrize("d", ["5", "1.5m", "inf", "infinity", "1e3", "+5", "0x10", ".5", "abc"])
def test_timeout_skips_one_duration_operand(d):
    assert destructive._skip_wrapper(f"timeout {d} ls -la".split(" "), 0, "timeout") == 2
    assert destructive._skip_wrapper(f"timeout -s KILL -k 3 {d} ls".split(" "), 0, "timeout") == 6


def test_timeout_edges():
    assert destructive._skip_wrapper("timeout -- inf ls".split(" "), 0, "timeout") == 3
    assert destructive._skip_wrapper(["timeout"], 0, "timeout") == 1


@pytest.mark.parametrize("cmd,name,expected", [
    ("nice --adjustment 10 ls", "nice", False),
    ("nice -n 10 ls", "nice", False),
    ("timeout -s KILL inf ls", "timeout", False),
    ("stdbuf --output=L ls", "stdbuf", False),
    ("nice --adj 10 ls", "nice", True),
    ("nice --future 10 ls", "nice", True),
    ("ionice -t ls", "ionice", True),
    ("nohup 10 ls", "nohup", True),
    ("nohup a:b ls", "nohup", True),
])
def test_unsure_marking(cmd, name, expected):
    info = {}
    destructive._skip_wrapper(cmd.split(" "), 0, name, info)
    assert info.get("unsure", False) is expected


def _cpu_seconds(cmd):
    t0 = time.process_time()
    check_command(cmd)
    return time.process_time() - t0


def test_many_later_words_stay_within_budget():
    """4x the words must cost about 4x the CPU (a quadratic scan would cost about 16x). The check compares two sizes
    measured in the same process, so it does not depend on how fast the CI runner is."""
    def build(n):
        return "nice --adj 5 echo " + "rm sh find dd " * n

    assert check_command(build(4000)).verdict == "block"
    small_in, large_in = build(1000), build(4000)
    check_command(build(250))  # warm-up: compiled patterns and caches are paid outside the measurement
    small = min(_cpu_seconds(small_in), _cpu_seconds(small_in))
    large = min(_cpu_seconds(large_in), _cpu_seconds(large_in))
    assert large < 8 * max(small, 1e-6), f"4x the input took {large / max(small, 1e-6):.1f}x the CPU ({small:.3f} s -> {large:.3f} s)"
