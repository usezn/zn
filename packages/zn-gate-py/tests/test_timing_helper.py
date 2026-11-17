"""Self-tests of tests/_timing.py: the helper must fail quadratic work, pass linear work and stop a hang."""

import sys
import time

import pytest

from ._timing import assert_linear

_FLOOR = 0.01  # a small floor keeps these checks well under a second


def _quadratic(text):
    count = 0
    for _ in text:
        for _ in text:
            count += 1
    return count


def _linear(text):
    count = 0
    for char in text:
        count += ord(char)
    return count


def _hang(_text):
    while True:
        time.sleep(0.01)


def test_quadratic_work_fails():
    # the small run is shorter than the floor: it is repeated, not replaced by the floor, so the growth still shows
    with pytest.raises(AssertionError, match="4x the input"):
        assert_linear(_quadratic, lambda n: "a" * n, 800, floor=_FLOOR)


def test_linear_work_passes():
    assert_linear(_linear, lambda n: "a" * n, 200000, floor=_FLOOR)


def test_work_errors_reach_the_test():
    def boom(_text):
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        assert_linear(boom, lambda n: "a" * n, 100, floor=_FLOOR)


@pytest.mark.skipif(not sys.platform.startswith(("linux", "darwin")), reason="the deadline needs fork")
def test_hang_is_killed_at_the_deadline():
    t0 = time.monotonic()
    with pytest.raises(AssertionError, match="did not finish within"):
        assert_linear(_hang, lambda n: "a" * n, 100, "a hanging scan", deadline=0.5)
    assert time.monotonic() - t0 < 10
