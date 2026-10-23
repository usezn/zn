"""
zn-gate: Deterministic, ultra-fast, zero-dependency guardrail engine for AI agents and LLM tool calling.
"""

__version__ = "1.13.1"

from .pii import find_pii, redact_pii, PII_TYPES
from .rules import Assessment, RULES_VERSION, evaluate, normalize_input, redact_secrets, sanitize_tool_result, SanitizedToolResult
from .guard import guard, check_tool_call, check_tool_result, GuardBlockError
from .destructive import check_command
from .client import analyze, analyze_cloud, is_cloud_enabled, resolve_endpoint
from .evidence import log_evidence, verify_evidence_ledger, get_evidence_stats, export_evidence_ledger, GENESIS_HASH

__all__ = [
    "evaluate",
    "normalize_input",
    "redact_secrets",
    "find_pii",
    "redact_pii",
    "PII_TYPES",
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
