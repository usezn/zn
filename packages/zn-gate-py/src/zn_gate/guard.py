"""
zn guardrail decorator and tool-call checkers for AI agents and LLM applications.
Pure Python stdlib. Zero external dependencies.
"""

from __future__ import annotations

import functools
import inspect
import os
from collections.abc import Mapping
from typing import Any, Callable, List, Optional, Set, Tuple, TypeVar, cast

from .rules import Assessment, evaluate, scan_windows


_F = TypeVar("_F", bound=Callable[..., Any])


def block_message(assessment: Assessment, target: str) -> str:
    """Plain text for a blocked call or tool result: what was blocked, why, and the next step."""
    reason = (assessment.reason or "").rstrip(".")
    if reason:
        why = f"Reason: {reason} (rule: {assessment.rule})."
    else:
        why = f"Reason: the input matched rule {assessment.rule}."
    if target.endswith((":result", ":tool_output")):
        step = "Next step: do not use this result; ask the person who runs this agent where the data came from."
    else:
        step = "Next step: do not retry with reworded text; tell the person who runs this agent."
    return f"zn-gate blocked '{target}'. {why} {step}"


class GuardBlockError(PermissionError):
    """Raised when an LLM tool call or input is blocked by zn-gate."""
    def __init__(self, assessment: Assessment, target: str = "", payload: Any = None):
        super().__init__(block_message(assessment, target))
        self.assessment = assessment
        self.target = target
        self.payload = payload


class _NestingTooDeep(Exception):
    """Raised when a payload is nested deeper than the scanner is willing to walk."""


def _extract_strings(data: Any, max_depth: int = 10, _path: Optional[Set[int]] = None) -> List[str]:
    """Recursively extract all strings from nested structures.

    Walks every Mapping (keys and values), list, tuple, set and frozenset, and
    decodes bytes. Raises _NestingTooDeep instead of silently skipping content
    that sits below the depth limit, so callers can fail closed. A container
    that contains itself is walked once.
    """
    if isinstance(data, str):
        return [data]
    if isinstance(data, (bytes, bytearray)):
        return [bytes(data).decode("utf-8", errors="replace")]
    if isinstance(data, Mapping):
        children: List[Any] = []
        for k, v in data.items():
            children.append(k)
            children.append(v)
    elif isinstance(data, (list, tuple, set, frozenset)):
        children = list(data)
    else:
        return []
    if max_depth <= 0:
        raise _NestingTooDeep()
    path = _path if _path is not None else set()
    if id(data) in path:
        return []
    path.add(id(data))
    try:
        strings: List[str] = []
        for child in children:
            strings.extend(_extract_strings(child, max_depth - 1, path))
        return strings
    finally:
        path.discard(id(data))


def check_tool_call(tool_name: str, arguments: Any = None, strict: Optional[bool] = None) -> Assessment:
    """
    Evaluates whether an agent tool call is safe to execute.
    Inspects tool arguments recursively for injection, evasion, or exfiltration attacks.
    """
    try:
        strings_to_check = _extract_strings(arguments)
    except _NestingTooDeep:
        return Assessment(verdict="block", confidence=1.0, rule="size:nesting",
                          reason="Arguments nested too deeply to check")
    advisory = None
    for s in strings_to_check:
        res = evaluate(s, strict=strict)
        if not res.allowed:
            return res
        advisory = advisory or res.advisory
    return Assessment(verdict="allow", confidence=1.0, rule="none", reason=None,
                      advisory=dict(advisory) if advisory else None)


def check_tool_result(result: Any, block_truncated: bool = False, strict: Optional[bool] = None) -> Assessment:
    """
    Evaluates data returned by external tools (e.g. web search, file content, DB queries)
    for indirect prompt injections or leaked credentials.
    Large strings are scanned in overlapping windows (see rules.scan_windows);
    the result has truncated=True when some string was not fully analysed. Such
    output is blocked (rule size:truncated) when block_truncated is set or the
    ZN_BLOCK_TRUNCATED environment variable is "1".
    """
    try:
        strings_to_check = _extract_strings(result)
    except _NestingTooDeep:
        return Assessment(verdict="block", confidence=1.0, rule="size:nesting",
                          reason="Result nested too deeply to check")
    truncated = False
    advisory = None
    for s in strings_to_check:
        res = scan_windows(s, strict=strict)
        if not res.allowed:
            return res
        truncated = truncated or res.truncated
        advisory = advisory or res.advisory
    if truncated and (block_truncated or os.environ.get("ZN_BLOCK_TRUNCATED") == "1"):
        return Assessment(verdict="block", confidence=1.0, rule="size:truncated",
                          reason="Output too large to scan in full", truncated=True)
    return Assessment(verdict="allow", confidence=1.0, rule="none", reason=None, truncated=truncated,
                      advisory=dict(advisory) if advisory else None)


def validate_on_block(value: Any, allowed: Tuple[str, ...]) -> str:
    """Return `value` if it is one of the `allowed` modes, else raise ValueError.

    An unknown mode (for example a typo such as "rasie") would otherwise skip the
    block silently, so every integration checks it when it is created.
    """
    if not isinstance(value, str) or value not in allowed:
        valid = ", ".join(repr(v) for v in allowed)
        raise ValueError(f"on_block must be one of {valid}; got {value!r}")
    return value


def guard(
    on_block: str = "raise",
    fallback: Any = None,
    check_args: bool = True,
    check_result: bool = False,
    mask_secrets: bool = False,
    callback: Optional[Callable[[Assessment, str, Any], None]] = None,
    block_truncated: bool = False,
) -> Callable[[_F], _F]:
    """
    Decorator for Python functions and agent tools.

    Parameters:
    - on_block: "raise" (default) raises GuardBlockError,
                "return" returns `fallback` (or the Assessment if fallback is None),
                "custom" calls `callback`.
    - fallback: Value to return if on_block="return".
    - check_args: Whether to inspect input arguments (default True).
    - check_result: Whether to inspect function return value (default False).
    - mask_secrets: Automatically redact leaked credentials in result (default False).
    - callback: Optional hook called on block: callback(assessment, func_name, payload).
    - block_truncated: With check_result, block a result too large to scan in full
                       (rule size:truncated). ZN_BLOCK_TRUNCATED=1 does the same
                       for every guard (default False).
    """
    validate_on_block(on_block, ("raise", "return", "custom"))

    def decorator(func: _F) -> _F:
        func_name = getattr(func, "__name__", "anonymous")

        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                if check_args:
                    combined_args = {"args": args, "kwargs": kwargs}
                    assessment = check_tool_call(func_name, combined_args)
                    if not assessment.allowed:
                        if callback:
                            callback(assessment, func_name, combined_args)
                        if on_block == "raise":
                            raise GuardBlockError(assessment, target=func_name, payload=combined_args)
                        elif on_block == "return":
                            return fallback if fallback is not None else assessment

                res = await func(*args, **kwargs)

                if check_result:
                    res_assessment = check_tool_result(res, block_truncated=block_truncated)
                    if not res_assessment.allowed:
                        if callback:
                            callback(res_assessment, func_name, res)
                        if on_block == "raise":
                            raise GuardBlockError(res_assessment, target=f"{func_name}:result", payload=res)
                        elif on_block == "return":
                            return fallback if fallback is not None else res_assessment

                if mask_secrets:
                    from .rules import sanitize_tool_result
                    res, _ = sanitize_tool_result(res)

                return res
            return cast(_F, async_wrapper)
        else:
            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                if check_args:
                    combined_args = {"args": args, "kwargs": kwargs}
                    assessment = check_tool_call(func_name, combined_args)
                    if not assessment.allowed:
                        if callback:
                            callback(assessment, func_name, combined_args)
                        if on_block == "raise":
                            raise GuardBlockError(assessment, target=func_name, payload=combined_args)
                        elif on_block == "return":
                            return fallback if fallback is not None else assessment

                res = func(*args, **kwargs)

                if check_result:
                    res_assessment = check_tool_result(res, block_truncated=block_truncated)
                    if not res_assessment.allowed:
                        if callback:
                            callback(res_assessment, func_name, res)
                        if on_block == "raise":
                            raise GuardBlockError(res_assessment, target=f"{func_name}:result", payload=res)
                        elif on_block == "return":
                            return fallback if fallback is not None else res_assessment

                if mask_secrets:
                    from .rules import sanitize_tool_result
                    res, _ = sanitize_tool_result(res)

                return res
            return cast(_F, sync_wrapper)

    return decorator

