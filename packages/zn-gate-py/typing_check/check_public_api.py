"""Type-level checks for the public API. Never run: CI checks it with `mypy --strict`.

If a signature in zn_gate changes shape, a line here stops type-checking.
A `type: ignore` line must keep failing, or mypy reports it as unused.
"""

from typing import Any, Coroutine, Dict, List, Optional, Tuple

from typing_extensions import assert_type

import zn_gate
from zn_gate import (
    Assessment,
    GuardBlockError,
    SanitizedToolResult,
    analyze,
    check_tool_call,
    check_tool_result,
    evaluate,
    export_evidence_ledger,
    get_evidence_stats,
    guard,
    log_evidence,
    redact_secrets,
    sanitize_tool_result,
    verify_evidence_ledger,
)


def check_assessments() -> None:
    assessment = evaluate("hello")
    assert_type(assessment, Assessment)
    assert_type(assessment.allowed, bool)
    assert_type(assessment.verdict, str)
    assert_type(assessment.reason, Optional[str])
    assert_type(assessment.to_dict(), Dict[str, Any])
    assert_type(check_tool_call("search", {"q": "x"}), Assessment)
    assert_type(check_tool_result("output", block_truncated=True), Assessment)
    evaluate(1)  # type: ignore[arg-type]


def check_redaction() -> None:
    text, detections = redact_secrets("value")
    assert_type(text, str)
    assert_type(detections, List[Dict[str, Any]])


def check_sanitize_overloads() -> None:
    # One argument: a (clean data, detections) tuple.
    pair = sanitize_tool_result({"a": "b"})
    assert_type(pair, Tuple[Any, List[Dict[str, Any]]])
    clean, found = sanitize_tool_result("text")
    assert_type(found, List[Dict[str, Any]])
    # Tool name and content: a typed dict.
    full = sanitize_tool_result("search", "some output")
    assert_type(full, SanitizedToolResult)
    assert_type(full["safe_to_ingest"], bool)
    assert_type(full["sanitized_content"], str)
    assert_type(full["assessment"], Assessment)
    assert_type(full["secrets_redacted"], int)
    full["missing"]  # type: ignore[typeddict-item]


def check_analyze() -> None:
    assert_type(analyze("hello"), Dict[str, Any])
    assert_type(analyze("hello", local_only=True, timeout=2.0), Dict[str, Any])
    analyze(b"bytes")  # type: ignore[arg-type]


def check_guard() -> None:
    @guard(on_block="return", fallback="blocked")
    def fetch(url: str, retries: int = 1) -> str:
        return url

    # The decorator keeps the signature of the wrapped function.
    assert_type(fetch("https://example.com"), str)
    fetch(1)  # type: ignore[arg-type]

    @guard(check_result=True)
    async def fetch_async(url: str) -> bytes:
        return url.encode()

    pending = fetch_async("https://example.com")
    checked = assert_type(pending, Coroutine[Any, Any, bytes])
    checked.close()

    err = GuardBlockError(evaluate("x"), target="tool")
    assert_type(err, GuardBlockError)


def check_evidence(path: str) -> None:
    assert_type(log_evidence({"event": "x"}, path), Optional[Dict[str, Any]])
    assert_type(verify_evidence_ledger(path), Dict[str, Any])
    assert_type(get_evidence_stats(path, limit=10), Dict[str, Any])
    assert_type(export_evidence_ledger(path, "jsonl"), Dict[str, Any])


def check_metadata() -> None:
    assert_type(zn_gate.__version__, str)
    assert_type(zn_gate.RULES_VERSION, str)
