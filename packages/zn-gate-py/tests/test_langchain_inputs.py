"""How the LangChain wrapper reads its input (_input) and builds the inner call (_inner_call).

Uses small fake tools and no network. Skipped when langchain-core is not installed.
"""
import os

import pytest

if os.environ.get("ZN_REQUIRE_FRAMEWORKS") == "1":
    import langchain_core  # noqa: F401
else:
    pytest.importorskip("langchain_core")

from langchain_core.tools import tool  # noqa: E402

from zn_gate.integrations import guard_langchain_tool  # noqa: E402
from zn_gate.integrations import langchain as lc  # noqa: E402


@tool
def plain_tool(topic: str) -> str:
    """Return a fixed line for a topic."""
    return "topic: " + topic


@tool(response_format="content_and_artifact")
def artifact_tool(topic: str) -> tuple:
    """Return a line and an artifact for a topic."""
    return "topic: " + topic, {"rows": [topic]}


def _set_call_id(value):
    return lc._CALL_ID.set(value)


# --- _input ---------------------------------------------------------------------------------

def test_input_uses_keyword_arguments():
    wrapped = guard_langchain_tool(plain_tool)
    assert wrapped._input((), {"topic": "deploy"}) == {"topic": "deploy"}


def test_input_prefers_keyword_arguments_over_a_positional_one():
    wrapped = guard_langchain_tool(plain_tool)
    assert wrapped._input(("ignored",), {"topic": "deploy"}) == {"topic": "deploy"}


def test_input_uses_a_single_positional_argument_as_is():
    wrapped = guard_langchain_tool(plain_tool)
    assert wrapped._input(("deploy",), {}) == "deploy"
    assert wrapped._input(({"topic": "deploy"},), {}) == {"topic": "deploy"}


def test_input_is_an_empty_dict_without_arguments():
    wrapped = guard_langchain_tool(plain_tool)
    assert wrapped._input((), {}) == {}


def test_input_is_an_empty_dict_for_several_positional_arguments():
    wrapped = guard_langchain_tool(plain_tool)
    assert wrapped._input(("a", "b"), {}) == {}


# --- _inner_call ----------------------------------------------------------------------------

def test_inner_call_passes_the_arguments_through_for_a_plain_tool():
    wrapped = guard_langchain_tool(plain_tool)
    token = _set_call_id("call-1")
    try:
        assert wrapped._inner_call({"topic": "deploy"}) == {"topic": "deploy"}
    finally:
        lc._CALL_ID.reset(token)


def test_inner_call_passes_a_non_dict_input_through_even_for_an_artifact_tool():
    wrapped = guard_langchain_tool(artifact_tool)
    assert wrapped._inner_call("deploy") == "deploy"


def test_inner_call_builds_a_full_tool_call_with_the_id_for_an_artifact_tool():
    wrapped = guard_langchain_tool(artifact_tool)
    token = _set_call_id("call-7")
    try:
        assert wrapped._inner_call({"topic": "deploy"}) == {
            "name": "artifact_tool", "args": {"topic": "deploy"}, "id": "call-7", "type": "tool_call"}
    finally:
        lc._CALL_ID.reset(token)


def test_inner_call_uses_a_placeholder_id_when_an_artifact_tool_has_no_call_id():
    wrapped = guard_langchain_tool(artifact_tool)
    call = wrapped._inner_call({})
    assert call == {"name": "artifact_tool", "args": {}, "id": "zn-gate", "type": "tool_call"}


def test_artifact_tool_returns_a_tool_message_with_the_artifact_for_a_full_call():
    wrapped = guard_langchain_tool(artifact_tool)
    msg = wrapped.invoke({"name": "artifact_tool", "args": {"topic": "deploy"}, "id": "call-9", "type": "tool_call"})
    assert msg.tool_call_id == "call-9"
    assert msg.content == "topic: deploy"
    assert msg.artifact == {"rows": ["deploy"]}
