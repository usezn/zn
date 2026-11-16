"""
zn-gate integrations for AI agent frameworks and security tools.

Each adapter is imported the first time one of its names is used, so using one
framework does not load the others.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any, Dict, List, Tuple

if TYPE_CHECKING:
    from .langchain import ZnGuardCallbackHandler, guard_langchain_tool
    from .crewai import guarded_tool
    from .llamaindex import ZnLlamaGuard
    from .native import adk_tool_callbacks, guard_pydantic_ai_toolset, openai_agents_tool_guardrails
    from .promptfoo import call_api, call_api as promptfoo_provider

# public name -> (submodule, attribute)
_LAZY: Dict[str, Tuple[str, str]] = {
    "ZnGuardCallbackHandler": ("langchain", "ZnGuardCallbackHandler"),
    "guard_langchain_tool": ("langchain", "guard_langchain_tool"),
    "guarded_tool": ("crewai", "guarded_tool"),
    "ZnLlamaGuard": ("llamaindex", "ZnLlamaGuard"),
    "adk_tool_callbacks": ("native", "adk_tool_callbacks"),
    "openai_agents_tool_guardrails": ("native", "openai_agents_tool_guardrails"),
    "guard_pydantic_ai_toolset": ("native", "guard_pydantic_ai_toolset"),
    "call_api": ("promptfoo", "call_api"),
    "promptfoo_provider": ("promptfoo", "call_api"),
}


def __getattr__(name: str) -> Any:
    target = _LAZY.get(name)
    if target is None:
        raise AttributeError("module %r has no attribute %r" % (__name__, name))
    value = getattr(importlib.import_module("." + target[0], __name__), target[1])
    globals()[name] = value
    return value


def __dir__() -> List[str]:
    return sorted(set(globals()) | set(_LAZY))


__all__ = [
    "ZnGuardCallbackHandler",
    "guard_langchain_tool",
    "guarded_tool",
    "ZnLlamaGuard",
    "adk_tool_callbacks",
    "openai_agents_tool_guardrails",
    "guard_pydantic_ai_toolset",
    "call_api",
    "promptfoo_provider",
]
