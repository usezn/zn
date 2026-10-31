"""
zn-gate: Deterministic, ultra-fast, zero-dependency guardrail engine for AI agents and LLM tool calling.
"""

from __future__ import annotations

import importlib
import sys
import types
from typing import TYPE_CHECKING, Any, Dict, List

__version__ = "1.14.1"

from .rules import Assessment, RULES_VERSION, evaluate, normalize_input, redact_secrets, sanitize_tool_result, SanitizedToolResult

if TYPE_CHECKING:
    from .guard import guard, check_tool_call, check_tool_result, GuardBlockError
    from .destructive import check_command
    from .evidence import log_evidence, verify_evidence_ledger, get_evidence_stats, export_evidence_ledger, GENESIS_HASH
    from .client import analyze, analyze_cloud, is_cloud_enabled, resolve_endpoint

# Public names that live in submodules, mapped to the submodule that defines
# them. Each submodule is imported the first time one of its names is used, so
# a process that only imports zn_gate and calls the rules never loads the guard,
# the destructive-command checks, the evidence ledger or the cloud client (which
# pulls in urllib, http.client, ssl and email).
_LAZY: Dict[str, str] = {
    "guard": "guard",
    "check_tool_call": "guard",
    "check_tool_result": "guard",
    "GuardBlockError": "guard",
    "check_command": "destructive",
    "log_evidence": "evidence",
    "verify_evidence_ledger": "evidence",
    "get_evidence_stats": "evidence",
    "export_evidence_ledger": "evidence",
    "GENESIS_HASH": "evidence",
    "analyze": "client",
    "analyze_cloud": "client",
    "is_cloud_enabled": "client",
    "resolve_endpoint": "client",
}


def __getattr__(name: str) -> Any:
    module_name = _LAZY.get(name)
    if module_name is None:
        raise AttributeError("module %r has no attribute %r" % (__name__, name))
    value = getattr(importlib.import_module("." + module_name, __name__), name)
    globals()[name] = value
    return value


class _PackageModule(types.ModuleType):
    def __setattr__(self, name: str, value: Any) -> None:
        # Importing the guard submodule binds it as zn_gate.guard, which would
        # replace the public guard function. Keep the function.
        if name in _LAZY and isinstance(value, types.ModuleType):
            return
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _PackageModule


def __dir__() -> List[str]:
    return sorted(set(globals()) | set(_LAZY))

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
