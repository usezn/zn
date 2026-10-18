"""
CrewAI tool protection for zn-gate.
"""
from __future__ import annotations
import functools
from typing import Any, Callable, Optional

from ..guard import GuardBlockError, block_message, check_tool_call, check_tool_result
from ..rules import sanitize_tool_result


def guarded_tool(
    on_block: str = "raise",
    mask_secrets: bool = True,
    fallback: Optional[str] = None,
    check_result: bool = False,
    block_truncated: bool = False,
) -> Callable:
    """
    Decorator for CrewAI custom tools (either class methods or tool functions).

    Parameters:
    - on_block: "raise" (default) raises GuardBlockError; "return" returns
                `fallback`, or the plain block message when fallback is None.
    - mask_secrets: Redact leaked credentials in the tool output (default True).
    - fallback: Value to return when on_block="return".
    - check_result: Also scan the tool output for prompt injection before the
                    agent sees it, like guard(check_result=True) (default False,
                    so existing tools behave as before). A blocked output raises
                    GuardBlockError (target "crewai:<tool>:result") or returns
                    `fallback` / the block message.
    - block_truncated: With check_result, block an output too large to scan in
                       full (rule size:truncated) (default False).
    """
    def decorator(tool_func: Callable) -> Callable:
        @functools.wraps(tool_func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            tool_name = getattr(tool_func, "__name__", "crewai_tool")
            assessment = check_tool_call(tool_name, {"args": args, "kwargs": kwargs})
            if not assessment.allowed:
                if on_block == "raise":
                    raise GuardBlockError(assessment, target=f"crewai:{tool_name}", payload=kwargs)
                if fallback is not None:
                    return fallback
                return block_message(assessment, f"crewai:{tool_name}")

            result = tool_func(*args, **kwargs)
            if check_result:
                res_assessment = check_tool_result(result, block_truncated=block_truncated)
                if not res_assessment.allowed:
                    target = f"crewai:{tool_name}:result"
                    if on_block == "raise":
                        raise GuardBlockError(res_assessment, target=target, payload=result)
                    if fallback is not None:
                        return fallback
                    return block_message(res_assessment, target)
            if mask_secrets:
                result, _ = sanitize_tool_result(result)
            return result
        return wrapper
    return decorator
