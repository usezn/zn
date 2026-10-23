"""@guard must still see arguments and results when it wraps common Python shapes.

The blocked string is a stock phrase from this package's own test fixtures.
A strict xfail entry would mark an open gap; none are open now.
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


def test_guard_of_nested_partial_bound_args_blocked():
    inner = functools.partial(lambda a, b, c=None: (a, b, c), BENIGN)
    outer = functools.partial(inner, BENIGN, c=BLOCK)
    g = guard()(outer)
    with pytest.raises(GuardBlockError):
        g()
    # A partial subclass is not flattened by functools, so it must be handled too.
    class P(functools.partial):
        pass
    g2 = guard()(P(P(lambda a, b: (a, b), BLOCK), BENIGN))
    with pytest.raises(GuardBlockError):
        g2()


def test_guard_of_partial_benign_runs_and_keyword_bound_blocked():
    g = guard()(functools.partial(lambda x, y=None: (x, y), BENIGN))
    assert g(BENIGN) == (BENIGN, BENIGN)
    h = guard()(functools.partial(lambda x, y=None: (x, y), y=BLOCK))
    with pytest.raises(GuardBlockError):
        h(BENIGN)


def test_classmethod_and_staticmethod_guard_above_class_and_instance():
    class C:
        @guard()
        @classmethod
        def cm(cls, x):
            return (cls, x)

        @guard()
        @staticmethod
        def sm(x):
            return x

    assert isinstance(C.__dict__["cm"], classmethod)
    assert isinstance(C.__dict__["sm"], staticmethod)
    assert C.cm(BENIGN) == (C, BENIGN)
    assert C().cm(BENIGN) == (C, BENIGN)
    assert C.sm(BENIGN) == BENIGN
    assert C().sm(BENIGN) == BENIGN
    for target in (C, C()):
        with pytest.raises(GuardBlockError):
            target.cm(BLOCK)
        with pytest.raises(GuardBlockError):
            target.sm(BLOCK)
