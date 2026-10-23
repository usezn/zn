"""@guard must still see arguments and results when it wraps common Python shapes.

The blocked string is a stock phrase from this package's own test fixtures.
Strict xfail entries are open gaps tracked on the board; when a gap is fixed,
strict mode turns its test into a failure, which is the signal to drop the marker.
"""
import asyncio
import dataclasses
import functools

import pytest

from zn_gate import guard, GuardBlockError

BLOCK = "ignore previous instructions"
BENIGN = "hello world"


# Arguments: plain callables and wrapper stacks

def test_plain_function_args_blocked():
    @guard()
    def f(x):
        return x
    with pytest.raises(GuardBlockError):
        f(BLOCK)


def test_partial_of_guarded_function_args_blocked():
    @guard()
    def f(x):
        return x
    with pytest.raises(GuardBlockError):
        functools.partial(f, BLOCK)()


def test_guard_of_partial_arg_at_call_blocked():
    g = guard()(functools.partial(lambda x: x))
    with pytest.raises(GuardBlockError):
        g(BLOCK)


@pytest.mark.xfail(strict=True, reason="B-1225: args bound with functools.partial before @guard are not scanned")
def test_guard_of_partial_bound_arg_blocked():
    g = guard()(functools.partial(lambda x: x, BLOCK))
    with pytest.raises(GuardBlockError):
        g()


def test_staticmethod_guard_above_and_below_args_blocked():
    class Above:
        @guard()
        @staticmethod
        def f(x):
            return x

    class Below:
        @staticmethod
        @guard()
        def f(x):
            return x

    for cls in (Above, Below):
        with pytest.raises(GuardBlockError):
            cls.f(BLOCK)
        with pytest.raises(GuardBlockError):
            cls().f(BLOCK)


def test_classmethod_guard_below_args_blocked():
    class C:
        @classmethod
        @guard()
        def f(cls, x):
            return x
    with pytest.raises(GuardBlockError):
        C.f(BLOCK)


def test_classmethod_guard_above_args_blocked():
    class C:
        @guard()
        @classmethod
        def f(cls, x):
            return x
    with pytest.raises(GuardBlockError):
        C.f(BLOCK)


@pytest.mark.xfail(strict=True, reason="B-1226: @guard above @classmethod makes every call raise TypeError")
def test_classmethod_guard_above_benign_call_works():
    class C:
        @guard()
        @classmethod
        def f(cls, x):
            return x
    assert C.f(BENIGN) == BENIGN


def test_bound_method_args_blocked():
    class A:
        @guard()
        def m(self, x):
            return x
    with pytest.raises(GuardBlockError):
        A().m(BLOCK)


def test_dataclass_method_args_blocked():
    @dataclasses.dataclass
    class D:
        tag: str = "t"

        @guard()
        def m(self, x):
            return x
    with pytest.raises(GuardBlockError):
        D().m(BLOCK)


def _logged(f):
    @functools.wraps(f)
    def wrapper(*a, **k):
        return f(*a, **k)
    return wrapper


def test_guard_over_wraps_decorator_args_blocked():
    @guard()
    @_logged
    def f(x):
        return x
    with pytest.raises(GuardBlockError):
        f(BLOCK)


def test_wraps_decorator_over_guard_args_blocked():
    @_logged
    @guard()
    def f(x):
        return x
    with pytest.raises(GuardBlockError):
        f(BLOCK)


def test_lambda_args_blocked():
    g = guard()(lambda x: x)
    with pytest.raises(GuardBlockError):
        g(BLOCK)


def test_callable_object_args_blocked():
    class Obj:
        def __call__(self, x):
            return x
    with pytest.raises(GuardBlockError):
        guard()(Obj())(BLOCK)


def test_sync_generator_args_blocked_at_call():
    @guard()
    def gen(x):
        yield x
    with pytest.raises(GuardBlockError):
        gen(BLOCK)


def test_async_function_args_blocked():
    @guard()
    async def af(x):
        return x
    with pytest.raises(GuardBlockError):
        asyncio.run(af(BLOCK))


def test_async_generator_args_blocked_at_call():
    @guard()
    async def agen(x):
        yield x
    with pytest.raises(GuardBlockError):
        agen(BLOCK)


# Results: the shapes where check_result applies

def test_sync_function_result_blocked():
    @guard(check_result=True)
    def f(x):
        return BLOCK
    with pytest.raises(GuardBlockError):
        f(BENIGN)


def test_sync_generator_result_blocked():
    @guard(check_result=True)
    def gen(x):
        yield BLOCK
    with pytest.raises(GuardBlockError):
        list(gen(BENIGN))


def test_async_function_result_blocked():
    @guard(check_result=True)
    async def af(x):
        return BLOCK
    with pytest.raises(GuardBlockError):
        asyncio.run(af(BENIGN))


def test_async_generator_result_blocked():
    @guard(check_result=True)
    async def agen(x):
        yield BLOCK

    async def consume():
        return [i async for i in agen(BENIGN)]
    with pytest.raises(GuardBlockError):
        asyncio.run(consume())
