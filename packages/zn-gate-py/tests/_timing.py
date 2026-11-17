"""Growth-ratio checks for the tests that guard against quadratic work.

An absolute time limit fails a correct change on a slow or busy CI runner and passes a quadratic scan on a fast
machine. assert_linear times the same work at a size and at 4x that size, after a warm-up, in CPU time of this process
(a busy shared runner can pause the test in the middle of a correct run; a scan that goes back over earlier text still
burns the CPU), and requires the larger run to use less than RATIO times the CPU of the smaller one: about 4x for linear
work, about 16x for quadratic work.

A run that is too short to measure is repeated, never padded: a repeat count k is doubled until the small input takes
at least FLOOR_S, and the large input is then timed with the same k, so both sides are real measurements of the same
number of calls and a quadratic function cannot hide behind a fixed floor.

The timed work runs in a forked child with a wall-clock deadline (DEADLINE_S), so a regex or parser that hangs is killed
and reported instead of stalling the run. Where fork does not exist (Windows) the work runs in this process and the job
timeout of the CI workflow is the backstop for a hang (pytest-timeout is not part of the CI requirements).
"""

import multiprocessing
import time

RATIO = 8.0
FLOOR_S = 0.02
DEADLINE_S = 60.0
MAX_REPEATS = 4096
_EPSILON_S = 1e-6  # only keeps a division from failing when the clock reads zero; it never stands in for a measurement


def _cpu_seconds(fn, arg, repeats):
    t0 = time.process_time()
    for _ in range(repeats):
        fn(arg)
    return time.process_time() - t0


def _measure(fn, build, n, ratio, floor):
    """Return (small, large, repeats): CPU seconds of `repeats` calls on the n // 4 input and on the n input."""
    small_in, large_in = build(max(n // 4, 1)), build(n)
    fn(build(max(n // 16, 1)))  # warm-up: imports, compiled patterns and caches are paid once, outside the measurement
    fn(small_in)  # and once at the small size itself, so the first timed run is not slower than the later ones
    repeats = 1
    while True:  # the best of two runs is what has to reach the floor, or a lucky fast run would drop below it again
        small = min(_cpu_seconds(fn, small_in, repeats), _cpu_seconds(fn, small_in, repeats))
        if small >= floor or repeats >= MAX_REPEATS:
            break
        repeats *= 2
    large = _cpu_seconds(fn, large_in, repeats)
    if large >= ratio * max(small, _EPSILON_S):
        large = min(large, _cpu_seconds(fn, large_in, repeats))  # a passing test costs one large run
    return small, large, repeats


def _child(conn, args):
    try:
        conn.send(("ok", _measure(*args)))
    except BaseException as exc:  # noqa: BLE001 - everything the work raises goes back to the test
        try:
            conn.send(("exc", exc))
        except Exception:  # noqa: BLE001 - an exception that does not pickle
            conn.send(("exc", RuntimeError(repr(exc))))
    finally:
        conn.close()


def _measure_with_deadline(fn, build, n, ratio, floor, deadline, where):
    try:
        ctx = multiprocessing.get_context("fork")
    except ValueError:  # no fork on this platform (Windows): measure here, the CI job timeout is the backstop
        result = _measure(fn, build, n, ratio, floor)
        assert result[1] < deadline, "took %.1f s of CPU%s" % (result[1], where)
        return result
    recv, send = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child, args=(send, (fn, build, n, ratio, floor)), daemon=True)
    proc.start()
    send.close()
    try:
        if not recv.poll(deadline):
            raise AssertionError("did not finish within %.0f s%s (a hang or a runaway scan); the work was killed" % (deadline, where))
        try:
            kind, value = recv.recv()
        except EOFError:
            proc.join(5)
            raise AssertionError("the timing child died without a result (exit code %s)%s" % (proc.exitcode, where)) from None
    finally:
        if proc.is_alive():
            proc.terminate()
            proc.join(5)
            if proc.is_alive():
                proc.kill()
                proc.join(5)
        else:
            proc.join(5)
        recv.close()
    if kind == "exc":
        raise value
    return value


def assert_linear(fn, build, n, label="", ratio=RATIO, floor=FLOOR_S, deadline=DEADLINE_S):
    """fn(build(k)) must take less than `ratio` times longer at k == n than at k == n // 4.

    build(k) makes the input at scale k and is not timed; fn(input) is the work that is timed. The input at n is the
    size the test is about; the smaller one is a quarter of it. Each size is the best of two runs (the larger one is
    run a second time only when the first run fails, so a passing test costs one large run).
    """
    where = " on %s" % label if label else ""
    small, large, repeats = _measure_with_deadline(fn, build, n, ratio, floor, deadline, where)
    got = large / max(small, _EPSILON_S)
    assert got < ratio, "4x the input took %.1fx the CPU time (%.3f s -> %.3f s for %d call(s))%s" % (
        got, small, large, repeats, where)
