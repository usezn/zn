"""
zn-gate: Deterministic, ultra-fast, zero-dependency guardrail engine for AI agents and LLM tool calling.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any, List

__version__ = "1.14.1"

from .rules import Assessment, RULES_VERSION, evaluate, normalize_input, redact_secrets, sanitize_tool_result, SanitizedToolResult
from .guard import guard, check_tool_call, check_tool_result, GuardBlockError
from .destructive import check_command
from .evidence import log_evidence, verify_evidence_ledger, get_evidence_stats, export_evidence_ledger, GENESIS_HASH

if TYPE_CHECKING:
    from .client import analyze, analyze_cloud, is_cloud_enabled, resolve_endpoint

# The cloud client pulls in urllib, http.client, ssl and email. It is imported
# the first time one of these names is used, so a process that only runs the
# local checks never loads it.
_LAZY_CLIENT = frozenset({"analyze", "analyze_cloud", "is_cloud_enabled", "resolve_endpoint"})


def __getattr__(name: str) -> Any:
    if name in _LAZY_CLIENT:
        value = getattr(importlib.import_module(".client", __name__), name)
        globals()[name] = value
        return value
    raise AttributeError("module %r has no attribute %r" % (__name__, name))


def __dir__() -> List[str]:
    return sorted(set(globals()) | _LAZY_CLIENT)

__all__ = [
    "evaluate",
    "normalize_input",
    "redact_secrets",
    "sanitize_tool_result",
    "Assessment",
    "SanitizedToolResult",
    "analyze",
    "analyze_cloud",
    "is_cloud_enabled",
    "resolve_endpoint",
    "guard",
    "check_tool_call",
    "check_tool_result",
    "check_command",
    "GuardBlockError",
    "log_evidence",
    "verify_evidence_ledger",
    "get_evidence_stats",
    "export_evidence_ledger",
    "GENESIS_HASH",
    "RULES_VERSION",
    "__version__",
]
