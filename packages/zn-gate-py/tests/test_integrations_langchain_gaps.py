"""Branches of integrations/langchain.py that the other LangChain tests do not reach.

Ordinary fake inputs only. Skipped when langchain-core is not installed. CI installs the
hash-pinned .github/ci-framework-test-requirements.txt for the python-coverage job and sets
ZN_REQUIRE_FRAMEWORKS=1, so there a missing framework fails the run instead of skipping.
"""
import importlib
import logging
import os
import sys
from types import SimpleNamespace
from typing import Annotated

import pytest

if os.environ.get("ZN_REQUIRE_FRAMEWORKS") == "1":
    import langchain_core  # noqa: F401
else:
    pytest.importorskip("langchain_core")

from langchain_core.tools import InjectedToolCallId, StructuredTool  # noqa: E402

from zn_gate import GuardBlockError  # noqa: E402
from zn_gate.integrations import ZnGuardCallbackHandler, guard_langchain_tool  # noqa: E402
from zn_gate.rules import Assessment  # noqa: E402

LC_MODULE = "zn_gate.integrations.langchain"


def _lc():
    return importlib.import_module(LC_MODULE)


def test_module_without_langchain_core_uses_the_stub_base_class(monkeypatch):
    lc = _lc()
    # A None entry makes the import of langchain_core.callbacks.base fail, as when the package is absent.
    monkeypatch.setitem(sys.modules, "langchain_core.callbacks.base", None)
    try:
        stub = importlib.reload(lc)
        assert stub._HAVE_LANGCHAIN is False
        assert stub.BaseCallbackHandler.__name__ == "BaseCallbackHandler"
        assert stub.BaseCallbackHandler.__module__ == LC_MODULE
        assert stub.ON_BLOCK_MODES == ("raise", "ignore")
    finally:
        monkeypatch.undo()
        importlib.reload(lc)  # restore the real classes for the other tests


def test_injected_keys_reads_injection_markers_on_the_annotation():
    lc = _lc()
    text = SimpleNamespace(metadata=[], annotation=str)
    call_id = SimpleNamespace(metadata=[], annotation=Annotated[str, InjectedToolCallId])
    full = SimpleNamespace(model_fields={"text": text, "tool_call_id": call_id})
    visible = SimpleNamespace(model_fields={"text": text})
    tool = SimpleNamespace(get_input_schema=lambda: full, tool_call_schema=visible)
    assert lc._injected_keys(tool) == frozenset({"tool_call_id"})


def test_injected_keys_is_empty_when_the_schema_cannot_be_read():
    lc = _lc()

    def broken():
        raise RuntimeError("no schema")

    tool = SimpleNamespace(get_input_schema=broken, tool_call_schema=SimpleNamespace(model_fields={}))
    assert lc._injected_keys(tool) == frozenset()


def _probe(func, **kwargs):
    return StructuredTool.from_function(func=func, name="probe", description="Probe tool.", **kwargs)


def test_guard_error_raised_by_the_inner_tool_propagates_unchanged():
    def inner(text: str = "hi"):
        raise GuardBlockError(
            Assessment(verdict="block", confidence=1.0, rule="test:inner", reason="inner tool blocked"),
            target="langchain:inner",
        )

    guarded = guard_langchain_tool(_probe(inner))
    with pytest.raises(GuardBlockError) as info:
        guarded.invoke({"text": "hi"})
    assert info.value.assessment.rule == "test:inner"


def test_other_inner_errors_propagate_when_checks_and_masking_are_off():
    def inner(text: str = "hi"):
        raise ValueError("plain failure")

    guarded = guard_langchain_tool(_probe(inner), check_result=False, mask_secrets=False)
    with pytest.raises(ValueError, match="plain failure"):
        guarded.invoke({"text": "hi"})


def test_callback_ignore_mode_logs_a_warning_and_keeps_output_when_a_secret_cannot_be_masked(monkeypatch, caplog):
    lc = _lc()
    unmaskable = Assessment(verdict="block", confidence=1.0, rule="secret:unmaskable", reason="test")
    monkeypatch.setattr(lc, "_mask_value", lambda content: (content, unmaskable))
    handler = ZnGuardCallbackHandler(on_block="ignore", mask_secrets=True)
    output = "some tool output"
    with caplog.at_level(logging.WARNING, logger="zn_gate"):
        assert handler.on_tool_end(output) is output
    # warn_ignored logs on the "zn_gate" logger: the target and the rule, never the text.
    messages = [r.getMessage() for r in caplog.records if r.name == "zn_gate" and r.levelno == logging.WARNING]
    assert any("langchain:tool_output" in m and "secret:unmaskable" in m and "on_block='ignore'" in m for m in messages)
    assert not any(output in m for m in messages)
