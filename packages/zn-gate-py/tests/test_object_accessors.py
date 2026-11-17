"""Objects that show values through properties or attribute hooks: the masker and the result checker refuse them."""

import dataclasses
import functools
from collections import namedtuple

import pytest

from zn_gate.guard import GuardBlockError, check_tool_call, check_tool_result, guard
from zn_gate.rules import SanitizeLimitError, sanitize_tool_result, unread_accessors

FAKE_KEY = "AKIAIOSFODNN7EXAMPLE"


class PropertyOnlyKey:
    """The credential is only reachable through a property; the text form is harmless."""

    def __init__(self):
        self.name = "lookup"

    @property
    def token(self):
        return "key " + FAKE_KEY

    def __str__(self):
        return "benign"


class SlotsPropertyKey:
    __slots__ = ()

    @property
    def token(self):
        return FAKE_KEY


class RaisingProperty:
    def __init__(self):
        self.name = "lookup"

    @property
    def token(self):
        raise RuntimeError("boom")


class HookKey:
    def __init__(self):
        self.name = "lookup"

    def __getattr__(self, name):
        if name == "token":
            return FAKE_KEY
        raise AttributeError(name)


class LazyKey:
    def __init__(self):
        self.name = "lookup"

    @functools.cached_property
    def token(self):
        return FAKE_KEY


class CustomDescriptor:
    def __get__(self, obj, owner=None):
        return FAKE_KEY

    def __set__(self, obj, value):
        raise AttributeError("read only")


class DescriptorKey:
    token = CustomDescriptor()


@dataclasses.dataclass
class Record:
    name: str
    note: str = "plain"


class Plain:
    def __init__(self, value):
        self.value = value

    def describe(self):
        return "a method is not a property"


Pair = namedtuple("Pair", "left right")

UNREAD = [PropertyOnlyKey, SlotsPropertyKey, RaisingProperty, HookKey, LazyKey, DescriptorKey]


@pytest.mark.parametrize("make", UNREAD)
def test_masking_refuses_an_object_with_unread_accessors(make):
    with pytest.raises(SanitizeLimitError) as exc:
        sanitize_tool_result(make())
    assert exc.value.rule == "type:unscannable"


@pytest.mark.parametrize("make", UNREAD)
def test_masking_refuses_it_nested_too(make):
    with pytest.raises(SanitizeLimitError) as exc:
        sanitize_tool_result({"items": [make()]})
    assert exc.value.rule == "type:unscannable"


@pytest.mark.parametrize("make", UNREAD)
def test_checker_blocks_an_object_with_unread_accessors(make):
    for result in (make(), {"items": [make()]}):
        res = check_tool_result(result)
        assert not res.allowed and res.rule == "type:unscannable"
        assert "properties" in (res.reason or "")


def test_property_only_key_is_never_returned():
    obj = PropertyOnlyKey()

    @guard(check_result=True)
    def checked():
        return obj

    with pytest.raises(GuardBlockError) as exc:
        checked()
    assert exc.value.assessment.rule == "type:unscannable"
    assert FAKE_KEY not in str(exc.value)

    @guard(mask_secrets=True)
    def masked_only():
        return obj

    with pytest.raises(GuardBlockError) as exc:
        masked_only()
    assert exc.value.assessment.rule == "type:unscannable"

    res = sanitize_tool_result("tool", obj)
    assert not res["safe_to_ingest"] and res["assessment"].rule == "type:unscannable"
    assert FAKE_KEY not in res["sanitized_content"]


def test_raising_property_is_never_called():
    assert unread_accessors(RaisingProperty())


def test_computed_cached_property_is_read_like_an_attribute():
    obj = LazyKey()
    assert unread_accessors(obj)
    _ = obj.token  # now stored in __dict__ and walked
    assert not unread_accessors(obj)
    clean, found = sanitize_tool_result(obj)
    assert found and FAKE_KEY not in clean.__dict__["token"]


def test_dataclass_and_plain_object_still_pass_through():
    rec = Record("hello")
    clean, found = sanitize_tool_result(rec)
    assert clean is rec and not found
    assert check_tool_result(rec).allowed
    obj = Plain("hello")
    clean, found = sanitize_tool_result(obj)
    assert clean is obj and not found
    assert check_tool_result(obj).allowed
    clean, found = sanitize_tool_result(Record(FAKE_KEY))
    assert found and isinstance(clean, Record) and FAKE_KEY not in clean.name


def test_namedtuple_and_standard_library_objects_still_pass_through():
    pair = Pair("a", FAKE_KEY)
    clean, found = sanitize_tool_result(pair)
    assert found and FAKE_KEY not in clean[1]
    assert check_tool_result(Pair("a", "b")).allowed
    from fractions import Fraction
    assert check_tool_result(Fraction(1, 2)).allowed
    assert sanitize_tool_result(Fraction(1, 2))[0] == Fraction(1, 2)


def test_pydantic_model_without_own_properties_still_passes_through():
    pydantic = pytest.importorskip("pydantic")

    class Model(pydantic.BaseModel):
        name: str = "hello"

    model = Model()
    assert not unread_accessors(model)
    assert check_tool_result(model).allowed
    clean, found = sanitize_tool_result(model)
    assert clean is model and not found

    class WithProperty(pydantic.BaseModel):
        name: str = "hello"

        @property
        def token(self):
            return FAKE_KEY

    assert not check_tool_result(WithProperty()).allowed


def test_arguments_with_properties_are_still_checked_as_before():
    # Only tool results are refused: an application object passed as an argument is never returned to the model.
    assert check_tool_call("tool", {"client": PropertyOnlyKey()}).allowed
    assert check_tool_call("tool", {"client": PropertyOnlyKey()}, _lenient_objects=True).allowed
