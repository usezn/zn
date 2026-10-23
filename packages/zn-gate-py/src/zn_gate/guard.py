"""
zn guardrail decorator and tool-call checkers for AI agents and LLM applications.
Pure Python stdlib. Zero external dependencies.
"""

from __future__ import annotations

import argparse
import dataclasses
import functools
import inspect
import io
import itertools
import logging
import os
from pathlib import PurePath
import types
from collections.abc import AsyncIterator, ItemsView, Iterable, Iterator, KeysView, Mapping, ValuesView
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Set, Tuple, TypeVar, cast

from .rules import Assessment, invisible_block, scan_windows, too_invisible
from .rules import MAX_SCAN_CHARS, MAX_TOOL_RESULT_SCAN_CHARS, _check_base64_pipes, truncated_blocks


_F = TypeVar("_F", bound=Callable[..., Any])


def block_message(assessment: Assessment, target: str) -> str:
    """Plain text for a blocked call or tool result: what was blocked, why, and the next step."""
    is_result = target.endswith((":result", ":tool_output"))
    too_large = assessment.rule == "size:truncated"
    if is_result:
        what = "The output of this tool was withheld, so the model did not receive it."
    else:
        what = "The call did not run, so nothing was sent or changed."
    if too_large:
        what = ("The output was too large to check in full, so it was withheld."
                if is_result else "The input was too large to check in full, so the call did not run.")
        why = f"Reason: too large to scan in full (rule: {assessment.rule})."
        if is_result:
            step = ("Next step: if you trust this tool, set ZN_ALLOW_TRUNCATED=1 to let large outputs "
                    "through without a full check (or pass allow_truncated=True to check_tool_result).")
        else:
            step = "Next step: shorten or split the input into smaller parts and try again."
        return f"zn-gate blocked '{target}'. {what} {why} {step}"
    reason = (assessment.reason or "").rstrip(".")
    if reason:
        why = f"Reason: {reason} (rule: {assessment.rule})."
    else:
        why = f"Reason: the input matched rule {assessment.rule}."
    if is_result:
        step = ("Next step: check where the data came from. If this is a false positive, "
                "report it at https://github.com/usezn/zn/issues.")
    else:
        step = ("Next step: check the input. If this is a false positive, "
                "report it at https://github.com/usezn/zn/issues.")
    return f"zn-gate blocked '{target}'. {what} {why} {step}"


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

# Depth limit for tool results, counted from the top of the payload, once the
# walk is inside an object that is not a data model (see _extract_strings).
# Deeper content still blocks (rule size:nesting); only the limit is higher
# than for dicts, lists and data models.
LENIENT_MAX_DEPTH = 32
_DEFAULT_MAX_DEPTH = 10

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


# Logging objects (a logger, a handler, a LoggerAdapter, the logging manager) are
# application plumbing that tools often receive next to the model's arguments.
# They hold no text the model chose and reach the whole logger registry, so they
# are not checked, like the run-context objects above.
_LOGGING_TYPES = (logging.Logger, logging.LoggerAdapter, logging.Handler, logging.Manager,
                  logging.Formatter, logging.Filter)


def _is_data_object(value: Any) -> bool:
    """True for objects that carry plain data: dataclasses, pydantic, attrs and msgspec
    models, and SimpleNamespace / argparse.Namespace.

    Agent frameworks build these from the model's tool-call arguments, and
    json.loads(..., object_hook=lambda d: SimpleNamespace(**d)) builds them
    from text, so they are walked as strictly as dicts and lists.
    """
    if isinstance(value, (types.SimpleNamespace, argparse.Namespace)):
        return True
    klass = type(value)
    return (dataclasses.is_dataclass(value)
            or hasattr(klass, "__pydantic_fields__") or hasattr(klass, "__fields__")
            or hasattr(klass, "__attrs_attrs__") or hasattr(klass, "__struct_fields__"))


def _extract_strings(data: Any, max_depth: int = 10, _path: Optional[Set[int]] = None,
                     _budget: Optional[List[int]] = None, _lenient: bool = False,
                     lenient_objects: bool = True,
                     lenient_depth: Optional[int] = None) -> List[str]:
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
    what sits past the value budget or cannot be read is left out instead of
    blocking. Such objects are built by the application, not from the
    model's arguments, and walking them in full blocked every call that
    passed one. Below the depth limit they are left out too, unless
    lenient_depth is set (as check_tool_result does, since a result carries
    outside data): the limit then rises to lenient_depth levels from the top
    and content deeper than that still raises _NestingTooDeep, and values past
    the budget raise _Unscannable as they do for data models. Pass
    lenient_objects=False (as check_tool_call does) to walk plain objects as
    strictly as data models: a payload hidden below the depth limit, in an
    unreadable object or past the value budget then raises like it does for
    dicts and lists.
    """
    if isinstance(data, str):
        return [data]
    if isinstance(data, (bytes, bytearray, memoryview)):
        return [bytes(data).decode("utf-8", errors="replace")]
    if data is None or isinstance(data, (bool, int, float, complex, type, types.ModuleType)) \
            or inspect.isroutine(data):
        return []
    if _is_framework_context(data) or isinstance(data, _LOGGING_TYPES):
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
        found = _extract_strings(path_value, max_depth, _path, budget, lenient_objects=lenient_objects,
                                lenient_depth=lenient_depth)
        # On Windows str() gives backslashes; the path rules also see the form with forward slashes.
        if isinstance(data, PurePath) and data.as_posix() != path_value:
            found += _extract_strings(data.as_posix(), max_depth, _path, budget, lenient_objects=lenient_objects,
                                lenient_depth=lenient_depth)
        return found
    elif isinstance(data, io.IOBase):
        # An open file or stream: its contents are read by the tool, not passed
        # as text, and reading them here would move the file position. Check its name.
        name = getattr(data, "name", None)
        return _extract_strings(name, max_depth, _path, budget, lenient_objects=lenient_objects,
                                lenient_depth=lenient_depth) if isinstance(name, (str, bytes)) else []
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
                if not lenient and not is_model and lenient_objects:
                    # Entering an application object: unreadable parts and the value
                    # budget become best effort; with lenient_depth the depth limit
                    # rises but content deeper than it still blocks.
                    lenient = True
                    if lenient_depth is not None:
                        max_depth += lenient_depth - _DEFAULT_MAX_DEPTH
            elif isinstance(data, Iterable):
                children = []
                for item in itertools.islice(data, max(budget[0], 0) + 1):
                    children.append(item)
        except Exception:
            if lenient or (not is_model and lenient_objects):
                return []
            raise _Unscannable("type:unscannable", "An object could not be read to check it") from None
        if children is None:
            return []
        if lenient and lenient_depth is None and budget[0] - len(children) < 0:
            return []
        budget[0] -= len(children)
        if budget[0] < 0:
            raise _Unscannable("size:items", "Too many values to check")
    if max_depth <= 0:
        if lenient and lenient_depth is None:
            return []
        raise _NestingTooDeep()
    path = _path if _path is not None else set()
    if id(data) in path:
        return []
    path.add(id(data))
    try:
        strings: List[str] = []
        for child in children:
            strings.extend(_extract_strings(child, max_depth - 1, path, budget, lenient, lenient_objects,
                                            lenient_depth))
        return strings
    finally:
        path.discard(id(data))


def _strings_or_block(data: Any, what: str, lenient_objects: bool = True,
                      lenient_depth: Optional[int] = None) -> Tuple[List[str], Optional[Assessment]]:
    """_extract_strings, or a block Assessment when the payload cannot be checked in full."""
    try:
        return _extract_strings(data, lenient_objects=lenient_objects, lenient_depth=lenient_depth), None
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


def _unwrap_partial(func: Any) -> Tuple[Any, Tuple[Any, ...], Dict[str, Any]]:
    """(innermost callable, arguments bound by functools.partial, keywords bound by it).
    Nested partials are flattened, the outer binding last so it wins on a repeated keyword."""
    bound_args: Tuple[Any, ...] = ()
    bound_kwargs: Dict[str, Any] = {}
    while isinstance(func, functools.partial):
        bound_args = tuple(func.args) + bound_args
        bound_kwargs = {**func.keywords, **bound_kwargs}
        func = func.func
    return func, bound_args, bound_kwargs


def _scan_strings(data: Any, what: str, block_truncated: bool, strict: Optional[bool],
                  lenient_objects: bool = True, allow_truncated: bool = False,
                  lenient_depth: Optional[int] = None) -> Assessment:
    strings_to_check, blocked = _strings_or_block(data, what, lenient_objects=lenient_objects,
                                                  lenient_depth=lenient_depth)
    if blocked is not None:
        return blocked
    if too_invisible(strings_to_check):
        return invisible_block()
    truncated = False
    advisory = None
    for s in strings_to_check:
        # Arguments over the scan limit are blocked, as the npm package does (its checkToolCall runs evaluate(),
        # which blocks them with size:oversize); a result keeps the truncated flag and is blocked unless allow_truncated).
        if what == "Arguments" and isinstance(s, str) and len(s) > MAX_TOOL_RESULT_SCAN_CHARS:
            return Assessment(verdict="block", confidence=1.0, rule="size:oversize",
                              reason="Input too large to scan in full", truncated=True)
        if what == "Arguments" and isinstance(s, str) and len(s) > MAX_SCAN_CHARS:
            # The npm package checks arguments with evaluate(), which finds Base64 decode pipes in the whole
            # input before the windowed scan (a long pipe can straddle two windows): do the same here.
            b64_block, _ = _check_base64_pipes((s,), strict)
            if b64_block is not None:
                return b64_block
        res = scan_windows(s, strict=strict)
        if not res.allowed:
            return res
        truncated = truncated or res.truncated
        advisory = advisory or res.advisory
    if truncated and ((what == "Arguments" and (block_truncated or os.environ.get("ZN_BLOCK_TRUNCATED") == "1"))
                      or (what != "Arguments" and truncated_blocks(block_truncated, allow_truncated))):
        return Assessment(verdict="block", confidence=1.0, rule="size:truncated",
                          reason=f"{what} too large to scan in full", truncated=True)
    return Assessment(verdict="allow", confidence=1.0, rule="none", reason=None, truncated=truncated,
                      advisory=dict(advisory) if advisory else None)


def check_tool_call(tool_name: str, arguments: Any = None, strict: Optional[bool] = None,
                    block_truncated: bool = False, _lenient_objects: bool = False) -> Assessment:
    """
    Evaluates whether an agent tool call is safe to execute.
    Inspects tool arguments recursively for injection, evasion, or exfiltration attacks:
    every string, mapping key and object attribute (see _extract_strings).
    Arguments that cannot be checked in full are blocked: nested too deeply
    (rule size:nesting, also for plain objects, as in the npm package), an
    object that cannot be read (rule type:unscannable), a one-shot iterator such as a generator (rule
    type:unscannable) or too many values (rule size:items).
    Long strings are scanned in overlapping windows up to 4 MB, as tool results
    are; the result has truncated=True when some string was not fully analysed,
    and such arguments are blocked (rule size:truncated) when block_truncated
    is set or the ZN_BLOCK_TRUNCATED environment variable is "1".
    """
    return _scan_strings(arguments, "Arguments", block_truncated=block_truncated, strict=strict,
                         lenient_objects=_lenient_objects)


def check_tool_result(result: Any, block_truncated: bool = False, strict: Optional[bool] = None,
                      allow_truncated: bool = False) -> Assessment:
    """
    Evaluates data returned by external tools (e.g. web search, file content, DB queries)
    for indirect prompt injections or leaked credentials.
    Large strings are scanned in overlapping windows (see rules.scan_windows);
    the result has truncated=True when some string was not fully analysed. Such
    output (over 4 MB) is blocked by default (rule size:truncated); allow_truncated=True
    or ZN_ALLOW_TRUNCATED=1 allows it, and block_truncated=True or ZN_BLOCK_TRUNCATED=1
    forces the block. A result that cannot be
    checked in full is blocked as for check_tool_call (for example a generator).
    """
    res = _scan_strings(result, "Result", block_truncated=block_truncated, strict=strict,
                        allow_truncated=allow_truncated, lenient_depth=LENIENT_MAX_DEPTH)
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


class MaskedToolError(RuntimeError):
    """A tool's exception whose message had to be masked, raised in place of it when
    the original exception type cannot be rebuilt with only the masked message."""


# Characters of the previous streamed chunk that are checked again with the
# next one, so a blocked phrase split between two chunks is still found.
STREAM_OVERLAP = 256

# With mask_secrets, a streamed result keeps this many characters of text back, so a
# secret that is split between two chunks is masked whole. The longest secret the
# masker matches in a bounded span is a JWT (8192 + 512 + 4096 characters plus the
# separators, about 12.8 thousand); a private key block is about 3.3 thousand
# characters for RSA 4096 and 6.4 thousand for RSA 8192. A secret with an open
# length (a credential value after a name such as api_key=) shrinks to one short
# placeholder as soon as it is masked, so it stays inside the held text however
# long it grows. 16 KiB covers all of them.
STREAM_MASK_HOLD = 16384
# New text is masked in batches: nothing is masked or passed on until the held
# text and the new chunks together exceed STREAM_MASK_HOLD by this much, so a
# stream of many small chunks does not mask the held text again for each chunk.
STREAM_MASK_BATCH = 4096
_ERROR_CHAIN_LIMIT = 8


def _safe_text(fn: Callable[[Any], str], value: Any) -> str:
    try:
        return str(fn(value))
    except Exception:
        return ""


def _mask_text(text: str) -> str:
    from . import rules
    masked, _ = rules.sanitize_tool_result(text)
    return masked if isinstance(masked, str) else text


class _StreamMasker:
    """Masks the chunks of a streamed result without letting a secret through where two
    chunks meet.

    Text (str, and bytes that are valid UTF-8) is appended to a buffer. When the
    buffer is longer than STREAM_MASK_HOLD + STREAM_MASK_BATCH it is masked as a
    whole, everything but its last STREAM_MASK_HOLD characters is passed on, and
    the masked tail stays in the buffer to be masked again with the next chunk.
    flush() masks and passes on what is left. Chunks of other types and bytes that
    are not UTF-8 text are masked one by one, after the buffer is flushed, so the
    order of the stream is kept.
    """

    def __init__(self) -> None:
        self.pending = ""
        self.kind: Optional[type] = None  # str or bytes: the type the held text is passed on as
        self._partial = b""  # the first bytes of a multi-byte character cut by a chunk end

    def _out(self, text: str) -> Any:
        return text.encode("utf-8") if self.kind is bytes else text

    def empty(self) -> Any:
        """An empty chunk of the type of the held text."""
        return b"" if self.kind is bytes else ""

    def flush(self) -> List[Any]:
        """Everything still held, masked, and empty the masker."""
        pieces: List[Any] = []
        if self.pending:
            pieces.append(self._out(_mask_text(self.pending)))
        if self._partial:
            pieces.append(self._partial)
        self.pending = ""
        self.kind = None
        self._partial = b""
        return pieces

    def _decode(self, data: bytes) -> Optional[str]:
        """The text of data after the bytes held from the last chunk, or None when it is not UTF-8."""
        data = self._partial + data
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            if exc.reason != "unexpected end of data" or exc.end != len(data):
                return None
            self._partial = data[exc.start:]
            return data[:exc.start].decode("utf-8")
        self._partial = b""
        return text

    def feed(self, chunk: Any) -> Tuple[List[Any], bool]:
        """(pieces to pass on now, True), or (what was flushed, False) when the chunk is not text:
        the caller then masks the chunk by itself and passes it on after those pieces."""
        pieces: List[Any] = []
        if isinstance(chunk, str):
            kind: type = str
            if self.kind is bytes:
                pieces = self.flush()
            text = chunk
        elif isinstance(chunk, (bytes, bytearray)):
            kind = bytes
            if self.kind is str:
                pieces = self.flush()
            decoded = self._decode(bytes(chunk))
            if decoded is None:
                return pieces + self.flush(), False
            text = decoded
        else:
            return self.flush(), False
        self.kind = kind
        self.pending += text
        if len(self.pending) > STREAM_MASK_HOLD + STREAM_MASK_BATCH:
            masked = _mask_text(self.pending)
            if len(masked) > STREAM_MASK_HOLD:
                ready, self.pending = masked[:-STREAM_MASK_HOLD], masked[-STREAM_MASK_HOLD:]
                pieces.append(self._out(ready))
            else:
                self.pending = masked
        return pieces, True


def _jsonlike(data: Any, depth: int = 0) -> Any:
    """Plain JSON-like data (str, number, bool, None, list, dict) holding the same values as `data`.

    Pydantic models, dataclasses and other objects become dicts of their fields,
    so a secret inside them can be masked.
    """
    if depth > 50:
        raise _Unscannable("secret:unmaskable", "A result with a secret is nested too deeply to mask")
    if data is None or isinstance(data, (str, bool, int, float)):
        return data
    if isinstance(data, (bytes, bytearray)):
        return bytes(data).decode("utf-8", "replace")
    if isinstance(data, Mapping):
        return {(k if isinstance(k, str) else str(_jsonlike(k, depth + 1))): _jsonlike(v, depth + 1)
                for k, v in data.items()}
    if isinstance(data, (list, tuple, set, frozenset, _DICT_VIEWS)):
        return [_jsonlike(v, depth + 1) for v in data]
    dump = getattr(data, "model_dump", None)
    if callable(dump) and not isinstance(data, type):
        try:
            return _jsonlike(dump(mode="json"), depth + 1)
        except Exception:
            pass
    if dataclasses.is_dataclass(data) and not isinstance(data, type):
        return {f.name: _jsonlike(getattr(data, f.name, None), depth + 1) for f in dataclasses.fields(data)}
    fields = _object_fields(data)
    if fields:
        return {str(fields[i]): _jsonlike(fields[i + 1], depth + 1) for i in range(0, len(fields), 2)}
    return str(data)


def _has_secret(data: Any) -> bool:
    return any(_mask_text(t) != t for t in _extract_strings(data, max_depth=50))


def _mask_value(res: Any) -> Tuple[Any, Optional[Assessment]]:
    """(value with secrets masked, None), or (res, a block Assessment) when a secret cannot be masked
    or the value is too deep, too large or contains itself (rule size:nesting or size:items).

    Strings, lists, dicts and tuples keep their type. A result that holds an
    object (a pydantic model, a dataclass...) with a secret in it comes back as
    the plain JSON-like value of that object, masked. A secret that still
    shows after masking blocks the result (rule "secret:unmaskable").
    """
    from . import rules
    try:
        clean, _ = rules.sanitize_tool_result(res)
    except rules.SanitizeLimitError as exc:
        # Nested too deeply, a container that contains itself or too many values: a controlled block.
        return res, Assessment(verdict="block", confidence=1.0, rule=exc.rule,
                               reason=f"The result cannot be masked: {exc.reason}")
    if isinstance(res, str):
        return clean, None
    try:
        if not _has_secret(clean):
            return clean, None
        masked, _ = rules.sanitize_tool_result(_jsonlike(res))
        if not _has_secret(masked):
            return masked, None
    except Exception:
        pass
    return res, Assessment(verdict="block", confidence=1.0, rule="secret:unmaskable",
                           reason="The result holds a secret that could not be masked")


def _error_texts(exc: BaseException) -> List[str]:
    """str() and repr() of an exception and of the exceptions chained to it."""
    texts: List[str] = []
    seen: Set[int] = set()
    cur: Optional[BaseException] = exc
    while cur is not None and id(cur) not in seen and len(seen) < _ERROR_CHAIN_LIMIT:
        seen.add(id(cur))
        texts.append(_safe_text(str, cur))
        texts.append(_safe_text(repr, cur))
        cur = cur.__cause__ or cur.__context__
    return texts


def _rebuild_error(exc: BaseException, message: str) -> BaseException:
    """A new exception of the same type as `exc` that carries only `message`.

    Agent frameworks send str(exc) (or repr) to the model, so the copy must not
    keep the original arguments, attributes, notes or chained exceptions. When
    the type cannot be rebuilt that way, MaskedToolError is used instead.
    """
    cls = type(exc)
    candidates: List[BaseException] = []
    try:
        candidates.append(cls(message))
    except Exception:
        pass
    try:
        bare = cls.__new__(cls)
        bare.args = (message,)
        candidates.append(bare)
    except Exception:
        pass
    for new in candidates:
        text, rtext = _safe_text(str, new), _safe_text(repr, new)
        if message not in text:
            continue
        if _mask_text(text) != text or _mask_text(rtext) != rtext:
            continue
        return new
    return MaskedToolError(message)


class _ResultPolicy:
    """What a guard does with what a tool gives back: its return value, the
    chunks of a streamed (generator) result, an awaitable, or an exception."""

    def __init__(self, name: str, target: str, check: bool, mask: bool, block_truncated: bool,
                 on_block: str, fallback: Any, callback: Optional[Callable[[Assessment, str, Any], None]],
                 default: Callable[[Assessment, str], Any]):
        self.name = name
        self.target = target
        self.check = check
        self.mask = mask
        self.block_truncated = block_truncated
        self.on_block = on_block
        self.fallback = fallback
        self.callback = callback
        self.default = default
        self.active = check or mask

    def blocked(self, assessment: Assessment, payload: Any) -> Any:
        """Return the stand-in value (on_block="return") or raise GuardBlockError."""
        if self.callback:
            self.callback(assessment, self.name, payload)
        if self.on_block == "return":
            return self.fallback if self.fallback is not None else self.default(assessment, self.target)
        raise GuardBlockError(assessment, target=self.target, payload=payload)

    def value(self, res: Any) -> Any:
        if self.check:
            assessment = check_tool_result(res, block_truncated=self.block_truncated)
            if not assessment.allowed:
                return self.blocked(assessment, res)
        if self.mask:
            res, unmaskable = _mask_value(res)
            if unmaskable is not None:
                return self.blocked(unmaskable, None)
        return res

    def finish(self, res: Any) -> Any:
        if not self.active:
            return res
        if inspect.isgenerator(res):
            return self._stream(res)
        if inspect.isasyncgen(res):
            return self._astream(res)
        if inspect.isawaitable(res):
            return self._awaited(res)
        return self.value(res)

    def handle_error(self, exc: Exception) -> Any:
        """Check and mask the message of a tool's exception, as a result would be.

        Must be called outside the `except` block, so the exception raised in
        its place has no link back to the original. Raises GuardBlockError
        (or returns the stand-in value with on_block="return") when the
        message is blocked, raises a copy with the masked message when it held
        a secret, and raises the original exception otherwise.
        """
        message = _safe_text(str, exc)
        if self.check:
            assessment = check_tool_result([message, _safe_text(repr, exc)],
                                           block_truncated=self.block_truncated)
            if not assessment.allowed:
                return self.blocked(assessment, _mask_text(message) if self.mask else None)
        if self.mask and any(_mask_text(t) != t for t in _error_texts(exc)):
            new = _rebuild_error(exc, _mask_text(message))
            raise new.with_traceback(exc.__traceback__) from None
        raise exc

    def call(self, func: Callable[..., Any], args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Any:
        caught: Optional[Exception] = None
        try:
            res = func(*args, **kwargs)
        except GuardBlockError:
            raise
        except Exception as exc:
            if not self.active:
                raise
            caught = exc
        if caught is not None:
            return self.handle_error(caught)
        return self.finish(res)

    async def acall(self, func: Callable[..., Any], args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Any:
        caught: Optional[Exception] = None
        try:
            res = await func(*args, **kwargs)
        except GuardBlockError:
            raise
        except Exception as exc:
            if not self.active:
                raise
            caught = exc
        if caught is not None:
            return self.handle_error(caught)
        return self.finish(res)

    async def _awaited(self, awaitable: Any) -> Any:
        caught: Optional[Exception] = None
        try:
            res = await awaitable
        except GuardBlockError:
            raise
        except Exception as exc:
            caught = exc
        if caught is not None:
            return self.handle_error(caught)
        return self.finish(res)

    def _chunk(self, chunk: Any, tail: str, masker: Optional[_StreamMasker] = None) -> Tuple[List[Any], str, bool]:
        """(pieces to pass on, new overlap tail, stop after this chunk).

        A blocked chunk ends the stream, and the text the masker still holds is withheld with it.
        """
        if self.check:
            assessment = check_tool_result(chunk, block_truncated=self.block_truncated)
            if assessment.allowed and tail and isinstance(chunk, str):
                joined = check_tool_result(tail + chunk, block_truncated=self.block_truncated)
                if not joined.allowed:
                    assessment = joined
            if not assessment.allowed:
                return [self.blocked(assessment, chunk)], "", True
        new_tail = (tail + chunk)[-STREAM_OVERLAP:] if isinstance(chunk, str) else ""
        if masker is None:
            return [chunk], new_tail, False
        pieces, handled = masker.feed(chunk)
        if handled:
            return pieces, new_tail, False
        masked, unmaskable = _mask_value(chunk)
        if unmaskable is not None:
            return pieces + [self.blocked(unmaskable, None)], "", True
        return pieces + [masked], new_tail, False

    def _stream(self, gen: Any) -> Any:
        policy = self

        def guarded_stream() -> Any:
            tail = ""
            sent = None
            masker = _StreamMasker() if policy.mask else None
            try:
                while True:
                    caught: Optional[Exception] = None
                    ended = False
                    result: Any = None
                    chunk: Any = None
                    try:
                        chunk = gen.send(sent)
                    except StopIteration as stop:
                        ended, result = True, stop.value
                    except GuardBlockError:
                        raise
                    except Exception as exc:
                        caught = exc
                    if ended or caught is not None:
                        # The end of the stream, or its failure: pass on the text still held first.
                        if masker is not None:
                            for piece in masker.flush():
                                yield piece
                        if caught is not None:
                            yield policy.handle_error(caught)
                            return None
                        return result
                    pieces, tail, done = policy._chunk(chunk, tail, masker)
                    if not pieces:
                        # Nothing to pass on yet: an empty chunk keeps one output per input chunk,
                        # so a value sent into the stream reaches the function at the right time.
                        pieces = [masker.empty() if masker is not None else chunk]
                    sent = None
                    for piece in pieces:
                        sent = yield piece
                    if done:
                        return None
            finally:
                gen.close()

        return guarded_stream()

    def _astream(self, agen: Any) -> Any:
        policy = self

        async def guarded_astream() -> Any:
            tail = ""
            sent = None
            masker = _StreamMasker() if policy.mask else None
            try:
                while True:
                    caught: Optional[Exception] = None
                    ended = False
                    chunk: Any = None
                    try:
                        chunk = await agen.asend(sent)
                    except StopAsyncIteration:
                        ended = True
                    except GuardBlockError:
                        raise
                    except Exception as exc:
                        caught = exc
                    if ended or caught is not None:
                        # The end of the stream, or its failure: pass on the text still held first.
                        if masker is not None:
                            for piece in masker.flush():
                                yield piece
                        if caught is not None:
                            yield policy.handle_error(caught)
                        return
                    pieces, tail, done = policy._chunk(chunk, tail, masker)
                    if not pieces:
                        # Nothing to pass on yet: an empty chunk keeps one output per input chunk,
                        # so a value sent into the stream reaches the function at the right time.
                        pieces = [masker.empty() if masker is not None else chunk]
                    sent = None
                    for piece in pieces:
                        sent = yield piece
                    if done:
                        return
            finally:
                await agen.aclose()

        return guarded_astream()


def _is_async_callable(func: Any) -> bool:
    """`async def` functions and callable objects whose `__call__` is `async def`."""
    # getattr with a default, not hasattr: an object without __call__ takes the sync path.
    return inspect.iscoroutinefunction(func) or inspect.iscoroutinefunction(
        getattr(func, "__call__", None)  # noqa: B004
    )


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
    - check_args: Whether to inspect input arguments (default True), as strictly
                  as check_tool_call does: an application object in them (a plain
                  class instance) that is nested deeper than ten levels, cannot
                  be read or holds too many values blocks the call (rules
                  size:nesting, type:unscannable, size:items). The instance of a
                  method (`self` or `cls`), framework run contexts and logging
                  objects are not inspected.
    - check_result: Whether to inspect function return value (default False).
    - mask_secrets: Automatically redact leaked credentials in result (default False).
    - callback: Optional hook called on block: callback(assessment, func_name, payload).
    - block_truncated: Force a block for arguments too large to scan in full
                       (rule size:truncated); ZN_BLOCK_TRUNCATED=1 does the same
                       for every guard (default False). With check_result, a
                       result over 4 MB is blocked by default; ZN_ALLOW_TRUNCATED=1
                       lets it through marked truncated (there is no per-guard
                       opt-out), and block_truncated=True keeps it blocked even then.

    With check_result or mask_secrets, what the function gives back is handled
    the same way whatever its form:
    - async: `async def` functions, callable objects whose `__call__` is
      `async def`, and sync functions that return a coroutine or other
      awaitable are awaited first, then checked and masked;
    - streamed: a generator or async generator result is passed on chunk by
      chunk, each chunk checked (together with the end of the previous one).
      A blocked chunk ends the stream: GuardBlockError, or the fallback as the
      last chunk with on_block="return". With mask_secrets the text is masked as
      one stream, so a secret split across chunks is masked whole: the last
      16 KiB of text are held back until more text or the end of the stream
      (also when the function fails) arrives. Each chunk the function yields
      still gives one chunk out, empty while its text is held, so the text
      comes out later and in larger pieces, in order and without gaps. The
      held text is withheld when a chunk blocks;
    - exceptions: the message of an exception raised by the function is
      checked and masked like a result, because agent frameworks pass it to
      the model. A blocked message raises GuardBlockError (or returns the
      fallback); a message with a secret is raised again as an exception of
      the same type (MaskedToolError when the type cannot be rebuilt) that
      carries only the masked message, without the original as its cause.
    Framework run-context arguments (pydantic-ai RunContext, Google ADK
    ToolContext, OpenAI Agents SDK ToolContext / RunContextWrapper, LangChain
    callback managers and RunnableConfig) are not checked.
    """
    validate_on_block(on_block, ("raise", "return", "custom"))
    if on_block == "custom" and callback is None:
        raise ValueError('on_block="custom" needs a callback; use on_block="raise" or pass callback=...')

    def decorator(func: _F) -> _F:
        if isinstance(func, (classmethod, staticmethod)):
            # Keep the descriptor: guard the plain function inside it and wrap it again
            # as the same kind, so calls through the class and through an instance work.
            return cast(_F, type(func)(decorator(func.__func__)))
        func_name = getattr(func, "__name__", "anonymous")
        target, bound_args, bound_kwargs = _unwrap_partial(func)

        def _on_args(args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Tuple[bool, Any]:
            """(True, value to return) when the call is blocked; raises in the raise and custom modes."""
            if bound_args or bound_kwargs:
                # Arguments fixed with functools.partial are scanned with the call arguments.
                args = bound_args + args
                kwargs = {**bound_kwargs, **kwargs}
            combined_args = {"args": args, "kwargs": kwargs}
            # Plain objects in the arguments are walked as strictly as check_tool_call does:
            # deeper than ten levels, unreadable or too large they block.
            assessment = check_tool_call(func_name, _call_payload(target, args, kwargs),
                                         block_truncated=block_truncated)
            if assessment.allowed:
                return False, None
            if callback:
                callback(assessment, func_name, combined_args)
            if on_block == "return":
                return True, fallback if fallback is not None else assessment
            raise GuardBlockError(assessment, target=func_name, payload=combined_args)

        policy = _ResultPolicy(func_name, f"{func_name}:result", check_result, mask_secrets,
                               block_truncated, on_block, fallback, callback,
                               default=lambda assessment, _target: assessment)

        if _is_async_callable(func):
            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                if check_args:
                    blocked, value = _on_args(args, kwargs)
                    if blocked:
                        return value
                return await policy.acall(func, args, kwargs)
            return cast(_F, async_wrapper)
        else:
            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                if check_args:
                    blocked, value = _on_args(args, kwargs)
                    if blocked:
                        return value
                return policy.call(func, args, kwargs)
            return cast(_F, sync_wrapper)

    return decorator
