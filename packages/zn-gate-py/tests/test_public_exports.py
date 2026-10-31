"""The public export list of zn_gate must stay stable."""

import zn_gate

EXPECTED_ALL = sorted([
    "Assessment",
    "GENESIS_HASH",
    "GuardBlockError",
    "RULES_VERSION",
    "SanitizedToolResult",
    "__version__",
    "analyze",
    "analyze_cloud",
    "check_command",
    "check_tool_call",
    "check_tool_result",
    "evaluate",
    "export_evidence_ledger",
    "get_evidence_stats",
    "guard",
    "is_cloud_enabled",
    "log_evidence",
    "normalize_input",
    "redact_secrets",
    "resolve_endpoint",
    "sanitize_tool_result",
    "verify_evidence_ledger",
])


def test_all_matches_expected_list():
    assert sorted(zn_gate.__all__) == EXPECTED_ALL


def test_all_has_no_duplicates():
    assert len(zn_gate.__all__) == len(set(zn_gate.__all__))


def test_every_exported_name_exists():
    for name in zn_gate.__all__:
        assert hasattr(zn_gate, name), name
