"""
CrewAI tool protection for zn-gate.
"""
from __future__ import annotations
import functools
import inspect
from typing import Any, Callable, Optional

from ..guard import GuardBlockError, block_message, check_tool_call, check_tool_result, validate_on_block
from ..rules import sanitize_tool_result


def guarded_tool(
    on_block: str = "raise",
    mask_secrets: bool = True,
    fallback: Optional[str] = None,
    check_result: bool = False,
    block_truncated: bool = False,
    framework: Optional[str] = None,
    on_block_callback: Optional[Callable[[Any, str, Any], None]] = None,
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
    - on_block_callback: Called as (assessment, name, payload) before a block is
                         applied (before raising or returning the fallback), for
                         blocked arguments (payload: {"args": ..., "kwargs": ...})
                         and, with check_result, blocked output (payload: the
                         output). Same as onBlockCallback in the Node guardTool.
                         It is not called when the call is allowed. If it raises,
                         the exception propagates and the call or result is
                         never allowed through (as in Node).

    Async tools (`async def`, or a callable object whose `__call__` is `async def`)
    get the same treatment: the call is awaited, then the output is checked and
    masked exactly as for a sync tool. A sync function that returns a coroutine,
    and an async generator, are not checked or masked: declare the tool with
    `async def` instead.
    """
    validate_on_block(on_block, ("raise", "return"))
    if on_block_callback is not None and not callable(on_block_callback):
        raise TypeError("guarded_tool: on_block_callback must be callable")
    prefix = framework if framework else "tool"

    def _finish(tool_name: str, result: Any, check_result: bool, block_truncated: bool,
                mask_secrets: bool, on_block: str, fallback: Optional[str]) -> Any:
        if check_result:
            res_assessment = check_tool_result(result, block_truncated=block_truncated)
            if not res_assessment.allowed:
                target = f"{prefix}:{tool_name}:result"
                if on_block_callback is not None:
                    on_block_callback(res_assessment, tool_name, result)
                if on_block == "raise":
                    raise GuardBlockError(res_assessment, target=target, payload=result)
                if fallback is not None:
                    return fallback
                return block_message(res_assessment, target)
        if mask_secrets:
            result, _ = sanitize_tool_result(result)
        return result

    def _blocked_input(tool_name: str, assessment: Any, kwargs: dict,
                       on_block: str, fallback: Optional[str], payload: Any = None) -> Any:
        if on_block_callback is not None:
            on_block_callback(assessment, tool_name, payload if payload is not None else kwargs)
        if on_block == "raise":
            raise GuardBlockError(assessment, target=f"{prefix}:{tool_name}", payload=kwargs)
        if fallback is not None:
            return fallback
        return block_message(assessment, f"{prefix}:{tool_name}")

    def decorator(tool_func: Callable) -> Callable:
        # getattr with a default, not hasattr: an object without __call__ takes the sync path.
        if inspect.iscoroutinefunction(tool_func) or inspect.iscoroutinefunction(
            getattr(tool_func, "__call__", None)  # noqa: B004
        ):
            @functools.wraps(tool_func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                tool_name = getattr(tool_func, "__name__", "tool")
                payload = {"args": args, "kwargs": kwargs}
                assessment = check_tool_call(tool_name, payload)
                if not assessment.allowed:
                    return _blocked_input(tool_name, assessment, kwargs, on_block, fallback, payload)

                result = await tool_func(*args, **kwargs)
                return _finish(tool_name, result, check_result, block_truncated,
                               mask_secrets, on_block, fallback)
            return async_wrapper

        @functools.wraps(tool_func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            tool_name = getattr(tool_func, "__name__", "tool")
            payload = {"args": args, "kwargs": kwargs}
            assessment = check_tool_call(tool_name, payload)
            if not assessment.allowed:
                return _blocked_input(tool_name, assessment, kwargs, on_block, fallback, payload)

            result = tool_func(*args, **kwargs)
            return _finish(tool_name, result, check_result, block_truncated,
                           mask_secrets, on_block, fallback)
        return wrapper
    return decorator
