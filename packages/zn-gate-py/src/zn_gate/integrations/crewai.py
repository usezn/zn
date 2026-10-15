"""
CrewAI tool protection for zn-gate.
"""
from __future__ import annotations
import functools
from typing import Any, Callable, Optional

from ..guard import GuardBlockError, block_message, check_tool_call
from ..rules import sanitize_tool_result


def guarded_tool(
    on_block: str = "raise",
    mask_secrets: bool = True,
    fallback: Optional[str] = None
) -> Callable:
    """
    Decorator for CrewAI custom tools (either class methods or tool functions).
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
            if mask_secrets:
                result, _ = sanitize_tool_result(result)
            return result
        return wrapper
    return decorator
