"""
zn guardrail decorator and tool-call checkers for AI agents and LLM applications.
Pure Python stdlib. Zero external dependencies.
"""

from __future__ import annotations

import dataclasses
import functools
import inspect
import io
import itertools
import os
import types
from collections.abc import AsyncIterator, ItemsView, Iterable, Iterator, KeysView, Mapping, ValuesView
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Set, Tuple, TypeVar, cast

from .rules import Assessment, scan_windows


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


class _Unscannable(Exception):
    """Raised when part of a payload cannot be checked without changing it, or is too big to walk."""

    def __init__(self, rule: str, reason: str):
        super().__init__(reason)
        self.rule = rule
        self.reason = reason


# Most values taken from objects and generic iterables (not lists, tuples,
# sets or dicts) that one payload may hold before it is blocked as too big to check.
MAX_OBJECT_VALUES = 100_000

_DICT_VIEWS = (KeysView, ValuesView, ItemsView)


def _object_fields(data: Any) -> Optional[List[Any]]:
    """Attribute names and values of an object (its __dict__ and __slots__), or None if it has none."""
    found = False
    children: List[Any] = []
    attrs = getattr(data, "__dict__", None)
    if isinstance(attrs, dict):
        found = True
        for k, v in attrs.items():
            children.append(k)
            children.append(v)
    seen: Set[str] = set()
    for klass in type(data).__mro__:
        slots = klass.__dict__.get("__slots__", ())
        if isinstance(slots, str):
            slots = (slots,)
        for name in slots:
            if not isinstance(name, str) or name in ("__dict__", "__weakref__") or name in seen:
                continue
            seen.add(name)
            try:
                value = object.__getattribute__(data, name)
            except AttributeError:
                continue
            found = True
            children.append(name)
            children.append(value)
    return children if found else None


# Context objects that agent frameworks pass to a tool next to the model's
# arguments: (module prefix, class names, or None for every class there).
# They hold the run state (messages, model, dependencies, callbacks), never
# text the model chose for this call, so they are not checked.
_FRAMEWORK_CONTEXT_TYPES: Tuple[Tuple[str, Optional[FrozenSet[str]]], ...] = (
    ("pydantic_ai", frozenset({"RunContext"})),
    ("google.adk", frozenset({"ToolContext", "CallbackContext", "InvocationContext",
                              "ReadonlyContext", "Context"})),
    ("agents.tool_context", frozenset({"ToolContext"})),
    ("agents.run_context", frozenset({"RunContextWrapper"})),
    ("langchain_core.callbacks", None),
    ("llama_index.core.workflow", frozenset({"Context"})),
)


def _is_framework_context(value: Any) -> bool:
    """True for a run-context object of a known agent framework (see _FRAMEWORK_CONTEXT_TYPES)."""
    if isinstance(value, (str, bytes, bytearray, Mapping, list, tuple, set, frozenset, type)):
        return False
    try:
        mro = type(value).__mro__
    except Exception:  # pragma: no cover - exotic metaclasses
        return False
    for klass in mro:
        module = getattr(klass, "__module__", None)
        if not isinstance(module, str):
            continue
        for prefix, names in _FRAMEWORK_CONTEXT_TYPES:
            if module == prefix or module.startswith(prefix + "."):
                if names is None or klass.__name__ in names:
                    return True
    return False


def _is_data_object(value: Any) -> bool:
    """True for objects that carry plain data: dataclasses, pydantic, attrs and msgspec models.

    Agent frameworks build these from the model's tool-call arguments, so they
    are walked as strictly as dicts and lists.
    """
    klass = type(value)
    return (dataclasses.is_dataclass(value)
            or hasattr(klass, "__pydantic_fields__") or hasattr(klass, "__fields__")
            or hasattr(klass, "__attrs_attrs__") or hasattr(klass, "__struct_fields__"))


def _extract_strings(data: Any, max_depth: int = 10, _path: Optional[Set[int]] = None,
                     _budget: Optional[List[int]] = None, _lenient: bool = False) -> List[str]:
    """Recursively extract all strings from nested structures.

    Walks every Mapping (keys and values), list, tuple, set, frozenset and dict
    view, decodes bytes, reads file-system paths, and walks the attributes of
    other objects (dataclasses, pydantic models and plain class instances,
    through __dict__ and __slots__) and the items of other re-iterable
    containers. Classes, modules, functions and the run-context objects of
    agent frameworks (see _FRAMEWORK_CONTEXT_TYPES) are skipped.

    Raises _NestingTooDeep instead of silently skipping content that sits
    below the depth limit, and _Unscannable for a one-shot iterator such as a
    generator (checking it would consume it, so the guarded function would get
    an empty iterator) or when objects and generic iterables hold more than
    MAX_OBJECT_VALUES values, so callers can fail closed. A container that
    contains itself is walked once.

    Inside an object that is not a data model (a plain class instance such as
    a client, a session or an agent's dependencies), the walk is best effort:
    what sits below the depth limit or past the value budget, or cannot be
    read, is left out instead of blocking. Such objects are built by the
    application, not from the model's arguments, and walking them in full
    blocked every call that passed one.
    """
    if isinstance(data, str):
        return [data]
    if isinstance(data, (bytes, bytearray, memoryview)):
        return [bytes(data).decode("utf-8", errors="replace")]
    if data is None or isinstance(data, (bool, int, float, complex, type, types.ModuleType)) \
            or inspect.isroutine(data):
        return []
    if _is_framework_context(data):
        return []
    budget = _budget if _budget is not None else [MAX_OBJECT_VALUES]
    lenient = _lenient
    children: Optional[List[Any]]
    if isinstance(data, Mapping):
        children = []
        for k, v in data.items():
            children.append(k)
            children.append(v)
    elif isinstance(data, (list, tuple, set, frozenset)):
        children = list(data)
    elif isinstance(data, os.PathLike):
        path_value = os.fspath(data)
        return _extract_strings(path_value, max_depth, _path, budget)
    elif isinstance(data, io.IOBase):
        # An open file or stream: its contents are read by the tool, not passed
        # as text, and reading them here would move the file position. Check its name.
        name = getattr(data, "name", None)
        return _extract_strings(name, max_depth, _path, budget) if isinstance(name, (str, bytes)) else []
    elif isinstance(data, Iterator) or isinstance(data, AsyncIterator):
        raise _Unscannable("type:unscannable",
                           "A one-shot iterator (such as a generator) cannot be checked "
                           "without consuming it; pass a list instead")
    elif isinstance(data, _DICT_VIEWS):
        children = list(data)
    else:
        # An object with attributes that is not a data model is walked best
        # effort; containers without attributes (deque, array, custom
        # sequences) and data models are walked strictly.
        is_model = _is_data_object(data)
        try:
            children = _object_fields(data)
            if children is not None:
                lenient = lenient or not is_model
            elif isinstance(data, Iterable):
                children = []
                for item in itertools.islice(data, max(budget[0], 0) + 1):
                    children.append(item)
        except Exception:
            if lenient or not is_model:
                return []
            raise _Unscannable("type:unscannable", "An object could not be read to check it") from None
        if children is None:
            return []
        if lenient and budget[0] - len(children) < 0:
            return []
        budget[0] -= len(children)
        if budget[0] < 0:
            raise _Unscannable("size:items", "Too many values to check")
    if max_depth <= 0:
        if lenient:
            return []
        raise _NestingTooDeep()
    path = _path if _path is not None else set()
    if id(data) in path:
        return []
    path.add(id(data))
    try:
        strings: List[str] = []
        for child in children:
            strings.extend(_extract_strings(child, max_depth - 1, path, budget, lenient))
        return strings
    finally:
        path.discard(id(data))


def _strings_or_block(data: Any, what: str) -> Tuple[List[str], Optional[Assessment]]:
    """_extract_strings, or a block Assessment when the payload cannot be checked in full."""
    try:
        return _extract_strings(data), None
    except _NestingTooDeep:
        return [], Assessment(verdict="block", confidence=1.0, rule="size:nesting",
                              reason=f"{what} nested too deeply to check")
    except _Unscannable as e:
        return [], Assessment(verdict="block", confidence=1.0, rule=e.rule,
                              reason=f"{what}: {e.reason}")


# Annotations of parameters that a framework fills with its own run settings
# (LangChain's RunnableConfig is a plain dict, so it cannot be told apart by type).
_CONTEXT_ANNOTATIONS = ("RunnableConfig",)


def _context_params(func: Any) -> Tuple[List[str], Set[str]]:
    """(parameter names in order, names annotated as a framework config such as RunnableConfig)."""
    try:
        params = inspect.signature(func).parameters
    except (TypeError, ValueError):
        return [], set()
    skip: Set[str] = set()
    for name, param in params.items():
        ann = param.annotation
        text = ann if isinstance(ann, str) else getattr(ann, "__name__", "") or repr(ann)
        if any(marker in text for marker in _CONTEXT_ANNOTATIONS):
            skip.add(name)
    return list(params), skip


def _call_payload(func: Any, args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """The arguments a guard checks: all of them, except the instance (self or cls) of a
    method and the run-context objects of agent frameworks (pydantic-ai RunContext,
    Google ADK ToolContext, OpenAI Agents SDK ToolContext / RunContextWrapper,
    LangChain callback managers and RunnableConfig)."""
    qualname = getattr(func, "__qualname__", "") or ""
    owner = qualname.rsplit(".", 1)[0] if "." in qualname else ""
    names, config_params = _context_params(func)
    if args and owner and not owner.endswith("<locals>"):
        if names and names[0] in ("self", "cls"):
            args = args[1:]
            names = names[1:]
    if config_params:
        args = tuple(a for i, a in enumerate(args) if not (i < len(names) and names[i] in config_params))
        kwargs = {k: v for k, v in kwargs.items() if k not in config_params}
    args = tuple(a for a in args if not _is_framework_context(a))
    kwargs = {k: v for k, v in kwargs.items() if not _is_framework_context(v)}
    return {"args": args, "kwargs": kwargs}


def _scan_strings(data: Any, what: str, block_truncated: bool, strict: Optional[bool]) -> Assessment:
    strings_to_check, blocked = _strings_or_block(data, what)
    if blocked is not None:
        return blocked
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
                          reason=f"{what} too large to scan in full", truncated=True)
    return Assessment(verdict="allow", confidence=1.0, rule="none", reason=None, truncated=truncated,
                      advisory=dict(advisory) if advisory else None)


def check_tool_call(tool_name: str, arguments: Any = None, strict: Optional[bool] = None,
                    block_truncated: bool = False) -> Assessment:
    """
    Evaluates whether an agent tool call is safe to execute.
    Inspects tool arguments recursively for injection, evasion, or exfiltration attacks:
    every string, mapping key and object attribute (see _extract_strings).
    Arguments that cannot be checked in full are blocked: nested too deeply
    (rule size:nesting), a one-shot iterator such as a generator (rule
    type:unscannable) or too many values (rule size:items).
    Long strings are scanned in overlapping windows up to 4 MB, as tool results
    are; the result has truncated=True when some string was not fully analysed,
    and such arguments are blocked (rule size:truncated) when block_truncated
    is set or the ZN_BLOCK_TRUNCATED environment variable is "1".
    """
    return _scan_strings(arguments, "Arguments", block_truncated, strict)


def check_tool_result(result: Any, block_truncated: bool = False, strict: Optional[bool] = None) -> Assessment:
    """
    Evaluates data returned by external tools (e.g. web search, file content, DB queries)
    for indirect prompt injections or leaked credentials.
    Large strings are scanned in overlapping windows (see rules.scan_windows);
    the result has truncated=True when some string was not fully analysed. Such
    output is blocked (rule size:truncated) when block_truncated is set or the
    ZN_BLOCK_TRUNCATED environment variable is "1". A result that cannot be
    checked in full is blocked as for check_tool_call (for example a generator).
    """
    res = _scan_strings(result, "Result", block_truncated, strict)
    if res.rule == "size:truncated":
        res.reason = "Output too large to scan in full"
    return res


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
                "custom" calls `callback` and then raises GuardBlockError, unless
                the callback raises its own exception first. "custom" needs a
                callback (ValueError otherwise). A blocked call never runs the
                function, and a blocked result is never returned.
    - fallback: Value to return if on_block="return".
    - check_args: Whether to inspect input arguments (default True). The instance
                  of a method (`self` or `cls`) is not inspected.
    - check_result: Whether to inspect function return value (default False).
    - mask_secrets: Automatically redact leaked credentials in result (default False).
    - callback: Optional hook called on block: callback(assessment, func_name, payload).
    - block_truncated: Block arguments, and with check_result a result, too large
                       to scan in full (rule size:truncated). ZN_BLOCK_TRUNCATED=1
                       does the same for every guard (default False).
    """
    validate_on_block(on_block, ("raise", "return", "custom"))
    if on_block == "custom" and callback is None:
        raise ValueError('on_block="custom" needs a callback; use on_block="raise" or pass callback=...')

    def decorator(func: _F) -> _F:
        func_name = getattr(func, "__name__", "anonymous")

        def _on_args(args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Tuple[bool, Any]:
            """(True, value to return) when the call is blocked; raises in the raise and custom modes."""
            combined_args = {"args": args, "kwargs": kwargs}
            assessment = check_tool_call(func_name, _call_payload(func, args, kwargs),
                                         block_truncated=block_truncated)
            if assessment.allowed:
                return False, None
            if callback:
                callback(assessment, func_name, combined_args)
            if on_block == "return":
                return True, fallback if fallback is not None else assessment
            raise GuardBlockError(assessment, target=func_name, payload=combined_args)

        def _on_result(res: Any) -> Any:
            if check_result:
                res_assessment = check_tool_result(res, block_truncated=block_truncated)
                if not res_assessment.allowed:
                    if callback:
                        callback(res_assessment, func_name, res)
                    if on_block == "return":
                        return fallback if fallback is not None else res_assessment
                    raise GuardBlockError(res_assessment, target=f"{func_name}:result", payload=res)

            if mask_secrets:
                from .rules import sanitize_tool_result
                res, _ = sanitize_tool_result(res)

            return res

        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                if check_args:
                    blocked, value = _on_args(args, kwargs)
                    if blocked:
                        return value
                res = await func(*args, **kwargs)
                return _on_result(res)
            return cast(_F, async_wrapper)
        else:
            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                if check_args:
                    blocked, value = _on_args(args, kwargs)
                    if blocked:
                        return value
                res = func(*args, **kwargs)
                return _on_result(res)
            return cast(_F, sync_wrapper)

    return decorator
