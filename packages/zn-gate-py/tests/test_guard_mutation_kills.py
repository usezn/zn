"""Tests that pin guard behaviour a mutation run showed was never asserted.

Each group below names what it protects. Fictitious values only; nothing here runs a command.
"""

import dataclasses
import importlib
import types

import pytest

from zn_gate.rules import MAX_SCAN_CHARS, MAX_TOOL_RESULT_SCAN_CHARS, Assessment

guard_module = importlib.import_module("zn_gate.guard")
KEY = "AKIA" + "IOSFODNN7EXAMPLE"


def _cls(name, module, **attrs):
    return type(name, (), {"__module__": module, **attrs})


# --- run-context objects of agent frameworks are not scanned; other classes of the same module are -----------------

@pytest.mark.parametrize("name,module", [
    ("RunContext", "pydantic_ai.tools"),
    ("ToolContext", "google.adk.tools"),
    ("RunContextWrapper", "agents.run_context"),
    ("Context", "llama_index.core.workflow.context"),
    ("Whatever", "langchain_core.callbacks.manager"),  # every class of this module counts
])
def test_framework_context_is_skipped(name, module):
    obj = _cls(name, module)()
    obj.note = "marker-text"
    assert guard_module._is_framework_context(obj)
    assert guard_module._extract_strings(obj) == []


@pytest.mark.parametrize("name,module", [
    ("Other", "pydantic_ai.tools"),
    ("RunContext", "agents.run_context"),
    ("ToolContext", "llama_index.core.workflow"),
    ("Context", "agents.tool_context"),
])
def test_other_class_of_a_framework_module_is_scanned(name, module):
    obj = _cls(name, module)()
    obj.note = "marker-text"
    assert not guard_module._is_framework_context(obj)
    assert "marker-text" in guard_module._extract_strings(obj)


def test_framework_context_is_found_through_a_base_class():
    base = _cls("RunContext", "pydantic_ai.tools")
    child = type("Mine", (base,), {"__module__": "app.tools"})()
    assert guard_module._is_framework_context(child)


# --- what counts as a data model (walked strictly) -------------------------------------------------------------------

@dataclasses.dataclass
class _DC:
    a: str = "x"


@pytest.mark.parametrize("attr", ["__pydantic_fields__", "__fields__", "__attrs_attrs__", "__struct_fields__"])
def test_each_model_marker_alone_makes_a_data_object(attr):
    klass = type("M", (), {attr: ()})
    assert guard_module._is_data_object(klass())


def test_dataclass_namespace_and_plain_object():
    import argparse
    assert guard_module._is_data_object(_DC())
    assert guard_module._is_data_object(types.SimpleNamespace(a=1))
    assert guard_module._is_data_object(argparse.Namespace(a=1))
    assert not guard_module._is_data_object(type("P", (), {})())


# --- a result object with a secret in it comes back as plain masked data ---------------------------------------------

class _Dumper:
    def __init__(self, payload):
        self._payload = payload

    def model_dump(self, mode="python"):
        return self._payload


class _Plain:
    def __init__(self):
        self.title = "report"
        self.token = f"key {KEY}"


class _Slotted:
    __slots__ = ("title", "token")

    def __init__(self):
        self.title = "report"
        self.token = f"key {KEY}"


@pytest.mark.parametrize("make", [
    lambda: _DC(a=f"key {KEY}"),
    lambda: _Dumper({"a": f"key {KEY}", "b": ["ok", {"c": KEY}]}),
    _Plain,
    _Slotted,
])
def test_object_result_with_a_secret_is_masked_not_blocked(make):
    value, blocked = guard_module._mask_value(make())
    assert blocked is None
    assert isinstance(value, dict)
    assert KEY not in repr(value)
    assert "[REDACTED" in repr(value)


def test_object_result_keeps_its_other_fields():
    value, blocked = guard_module._mask_value(_Plain())
    assert blocked is None
    assert value["title"] == "report"


def test_jsonlike_turns_objects_into_plain_data():
    out = guard_module._jsonlike({"a": (1, 2), "b": {3}, 4: b"by", "c": _DC(a="z"), "d": _Dumper({"k": "v"})})
    assert out == {"a": [1, 2], "b": [3], "4": "by", "c": {"a": "z"}, "d": {"k": "v"}}


def test_jsonlike_object_fields_pair_names_with_values():
    out = guard_module._jsonlike(_Plain())
    assert set(out) == {"title", "token"}
    assert out["title"] == "report"


def test_jsonlike_depth_limit_is_exactly_fifty():
    def nest(levels):
        v = "leaf"
        for _ in range(levels):
            v = [v]
        return v

    guard_module._jsonlike(nest(50))  # depth 50 is still allowed
    with pytest.raises(guard_module._Unscannable) as exc:
        guard_module._jsonlike(nest(51))
    assert exc.value.rule == "secret:unmaskable"


# --- the error chain read for secrets ---------------------------------------------------------------------------------

def test_error_chain_is_read_up_to_its_limit():
    exc = ValueError("e0")
    cur = exc
    for i in range(1, 20):
        nxt = ValueError(f"e{i}")
        cur.__cause__ = nxt
        cur = nxt
    texts = guard_module._error_texts(exc)
    assert len(texts) == 2 * guard_module._ERROR_CHAIN_LIMIT
    assert guard_module._ERROR_CHAIN_LIMIT == 8
    assert "e7" in texts and "e8" not in texts


def test_error_chain_follows_context_when_there_is_no_cause():
    try:
        try:
            raise ValueError("inner")
        except ValueError:
            raise KeyError("outer")
    except KeyError as exc:
        texts = guard_module._error_texts(exc)
    assert any("inner" in t for t in texts)


def test_error_chain_prefers_cause_over_context():
    try:
        try:
            raise ValueError("ctx")
        except ValueError:
            raise KeyError("outer") from RuntimeError("why")
    except KeyError as exc:
        texts = guard_module._error_texts(exc)
    assert any("why" in t for t in texts)
    assert not any("ctx" in t for t in texts)


def test_error_chain_stops_on_a_loop():
    a, b = ValueError("a"), ValueError("b")
    a.__cause__, b.__cause__ = b, a
    assert len(guard_module._error_texts(a)) == 4


# --- which arguments of a call are checked ---------------------------------------------------------------------------

class _Tool:
    def run(self, query, config: "RunnableConfig" = None):
        return query


def test_method_instance_is_not_scanned_but_other_args_are():
    t = _Tool()
    payload = guard_module._call_payload(_Tool.run, (t, "q1"), {})
    assert payload["args"] == ("q1",)


def test_config_param_after_the_instance_is_dropped_by_position():
    t = _Tool()
    cfg = {"callbacks": ["marker"]}
    payload = guard_module._call_payload(_Tool.run, (t, "q1", cfg), {"config": cfg})
    assert payload["args"] == ("q1",)
    assert payload["kwargs"] == {}


def test_method_of_a_class_defined_in_a_function_loses_its_instance():
    class Local:
        def run(self, query):
            return query

    payload = guard_module._call_payload(Local.run, (Local(), "q1"), {})
    assert payload["args"] == ("q1",)


def test_function_nested_in_a_function_keeps_a_first_arg_named_self():
    def outer():
        def inner(self, query):
            return query
        return inner

    payload = guard_module._call_payload(outer(), ("text", "q1"), {})
    assert payload["args"] == ("text", "q1")


def test_module_level_function_keeps_a_first_arg_named_self():
    def self_first(self, query):
        return query

    self_first.__qualname__ = "self_first"
    payload = guard_module._call_payload(self_first, ("text", "q1"), {})
    assert payload["args"] == ("text", "q1")


# --- block texts ----------------------------------------------------------------------------------------------------

def _block(rule, reason=None):
    return Assessment(verdict="block", confidence=1.0, rule=rule, reason=reason)


def test_block_message_for_a_result_and_for_a_call_differ():
    a = _block("path:sensitive_file", "Targeting a credential file")
    result = guard_module.block_message(a, "tool:result")
    call = guard_module.block_message(a, "tool")
    assert "output of this tool was withheld" in result and "check where the data came from" in result
    assert "did not run" in call and "check the input" in call
    assert "withheld" in guard_module.block_message(a, "x:tool_output")


def test_too_large_block_message_for_a_result_and_for_a_call():
    a = _block("size:truncated")
    result = guard_module.block_message(a, "tool:result")
    call = guard_module.block_message(a, "tool")
    assert "output was too large to check in full" in result and "ZN_ALLOW_TRUNCATED=1" in result
    assert "input was too large to check in full" in call and "shorten or split" in call


# --- arguments and results larger than one scan window ---------------------------------------------------------------

LONG = "a" * (MAX_SCAN_CHARS + 10)
HUGE = "a" * (MAX_TOOL_RESULT_SCAN_CHARS + 10)


@pytest.fixture(autouse=True)
def _no_truncation_env(monkeypatch):
    monkeypatch.delenv("ZN_BLOCK_TRUNCATED", raising=False)
    monkeypatch.delenv("ZN_ALLOW_TRUNCATED", raising=False)


def test_arguments_over_the_hard_limit_are_blocked_as_oversize():
    res = guard_module._scan_strings({"q": HUGE}, "Arguments", False, None)
    assert not res.allowed and res.rule == "size:oversize" and res.truncated


def test_result_over_the_hard_limit_blocks_by_default_and_allow_truncated_lets_it_through():
    blocked = guard_module._scan_strings(HUGE, "Result", False, None)
    assert not blocked.allowed and blocked.rule == "size:truncated"
    allowed = guard_module._scan_strings(HUGE, "Result", False, None, allow_truncated=True)
    assert allowed.allowed and allowed.truncated


def test_result_over_the_hard_limit_with_the_environment_opt_out(monkeypatch):
    monkeypatch.setenv("ZN_ALLOW_TRUNCATED", "1")
    res = guard_module._scan_strings(HUGE, "Result", False, None)
    assert res.allowed and res.truncated
    res = guard_module._scan_strings(HUGE, "Result", True, None, allow_truncated=True)
    assert not res.allowed and res.rule == "size:truncated"


def test_result_between_one_window_and_the_hard_limit_is_scanned_whole():
    res = guard_module._scan_strings(LONG, "Result", False, None)
    assert res.allowed and not res.truncated


def test_allowed_scan_has_full_confidence_and_no_rule():
    res = guard_module._scan_strings("hello there", "Arguments", False, None)
    assert res.allowed and res.confidence == 1.0 and res.rule == "none"
