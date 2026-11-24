"""Growth-ratio checks for the tests that guard against quadratic work.

An absolute time limit fails a correct change on a slow or busy CI runner and passes a quadratic scan on a fast
machine. These helpers time the same work at a size and at 4x that size, after a warm-up, in CPU time of this process
(a busy shared runner can pause the test in the middle of a correct run; a scan that goes back over earlier text still
burns the CPU), and require the larger run to use less than RATIO times the CPU of the smaller one: about 4x for linear
work, about 16x for quadratic work. FLOOR_S keeps a tiny small-run time from inflating the ratio; HANG_CAP_S only
catches a hang.
"""

import time

RATIO = 8.0
FLOOR_S = 0.05
HANG_CAP_S = 60.0


def cpu_seconds(fn, arg):
    t0 = time.process_time()
    fn(arg)
    return time.process_time() - t0


def assert_linear(fn, build, n, label="", ratio=RATIO, floor=FLOOR_S):
    """fn(build(k)) must take less than `ratio` times longer at k == n than at k == n // 4.

    build(k) makes the input at scale k and is not timed; fn(input) is the work that is timed. The input at n is the
    size the test is about; the smaller one is a quarter of it. Each size is the best of two runs (the larger one is
    run a second time only when the first run fails, so a passing test costs one large run).
    """
    small_n = max(n // 4, 1)
    fn(build(max(n // 16, 1)))  # warm-up: imports, compiled patterns and caches are paid once, outside the measurement
    small_in, large_in = build(small_n), build(n)
    small = min(cpu_seconds(fn, small_in) for _ in range(2))
    large = cpu_seconds(fn, large_in)
    if large >= ratio * max(small, floor):
        large = min(large, cpu_seconds(fn, large_in))
    got = large / max(small, floor)
    where = " on %s" % label if label else ""
    assert large < HANG_CAP_S, "took %.1f s of CPU%s" % (large, where)
    assert got < ratio, "4x the input took %.1fx the CPU time (%.3f s -> %.3f s)%s" % (got, small, large, where)
