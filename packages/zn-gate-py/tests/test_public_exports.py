"""The public export list of zn_gate must stay stable."""

import os
import re
import subprocess
import sys

import zn_gate

_SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))

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


def test_every_exported_name_imports_by_name():
    for name in zn_gate.__all__:
        scope = {}
        exec(f"from zn_gate import {name}", scope)
        assert scope[name] is getattr(zn_gate, name), name


def test_version_is_a_version_string():
    assert isinstance(zn_gate.__version__, str)
    assert re.fullmatch(r"\d+\.\d+\.\d+", zn_gate.__version__), zn_gate.__version__


_QUIET_PROBE = r"""
import socket

def _deny(*args, **kwargs):
    raise SystemExit("network call during import")

socket.socket.connect = _deny
socket.socket.connect_ex = _deny
socket.create_connection = _deny
socket.getaddrinfo = _deny

import zn_gate
"""


def test_import_prints_nothing_and_makes_no_network_call(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("ZN_")}
    env.update({
        "HOME": str(home),
        "USERPROFILE": str(home),
        "PYTHONPATH": _SRC,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    proc = subprocess.run(
        [sys.executable, "-c", _QUIET_PROBE],
        env=env, cwd=str(tmp_path), capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == ""
    assert proc.stderr == ""
