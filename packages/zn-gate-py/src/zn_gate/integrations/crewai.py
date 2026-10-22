"""
CrewAI tool protection for zn-gate.
"""
from __future__ import annotations
import functools
from typing import Any, Callable, Optional

from ..guard import (GuardBlockError, _call_payload, _is_async_callable, _ResultPolicy, block_message,
                     check_tool_call, validate_on_block)


def guarded_tool(
    on_block: str = "raise",
    mask_secrets: bool = True,
    fallback: Optional[str] = None,
    check_result: bool = False,
    block_truncated: bool = False,
    framework: Optional[str] = None,
) -> Callable:
    """
    Decorator for custom agent tools (CrewAI, Pydantic AI, Google ADK or plain
    Python functions; either class methods or tool functions).

    Parameters:
    - on_block: "raise" (default) raises GuardBlockError; "return" returns
                `fallback`, or the plain block message when fallback is None.
    - mask_secrets: Redact leaked credentials in the tool output (default True).
    - fallback: Value to return when on_block="return".
    - check_result: Also scan the tool output for prompt injection before the
                    agent sees it, like guard(check_result=True) (default False,
                    so existing tools behave as before). A blocked output raises
                    GuardBlockError (target "<framework>:<tool>:result") or returns
                    `fallback` / the block message.
    - block_truncated: With check_result, block an output too large to scan in
                       full (rule size:truncated) (default False).
    - framework: Prefix of the block target, "<framework>:<tool>" (default
                 "tool"). Pass "crewai" to label blocks as CrewAI tools.

    Async tools (`async def`, a callable object whose `__call__` is `async def`,
    or a sync function that returns a coroutine) get the same treatment: the
    call is awaited, then the output is checked and masked exactly as for a
    sync tool. A generator or async generator result is passed on chunk by
    chunk, each chunk checked and masked (a secret split across two chunks is
    not masked). The message of an exception raised by the tool is checked and
    masked like its output, because frameworks pass it to the model: a blocked
    message raises GuardBlockError (or returns the fallback), and a message
    with a secret is raised again as an exception of the same type carrying
    only the masked message. Framework run-context arguments (pydantic-ai
    RunContext, Google ADK ToolContext, OpenAI Agents SDK ToolContext) are not
    checked.
    """
    validate_on_block(on_block, ("raise", "return"))
    prefix = framework if framework else "tool"

    def _blocked_input(tool_name: str, assessment: Any, kwargs: dict) -> Any:
        if on_block == "raise":
            raise GuardBlockError(assessment, target=f"{prefix}:{tool_name}", payload=kwargs)
        if fallback is not None:
            return fallback
        return block_message(assessment, f"{prefix}:{tool_name}")

    def decorator(tool_func: Callable) -> Callable:
        tool_name = getattr(tool_func, "__name__", "tool")
        policy = _ResultPolicy(tool_name, f"{prefix}:{tool_name}:result", check_result, mask_secrets,
                               block_truncated, on_block, fallback, None, default=block_message)

        if _is_async_callable(tool_func):
            @functools.wraps(tool_func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                assessment = check_tool_call(tool_name, _call_payload(tool_func, args, kwargs))
                if not assessment.allowed:
                    return _blocked_input(tool_name, assessment, kwargs)
                return await policy.acall(tool_func, args, kwargs)
            return async_wrapper

        @functools.wraps(tool_func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            assessment = check_tool_call(tool_name, _call_payload(tool_func, args, kwargs))
            if not assessment.allowed:
                return _blocked_input(tool_name, assessment, kwargs)
            return policy.call(tool_func, args, kwargs)
        return wrapper
    return decorator
