"""Prints the verdict and rule id of every case in test/fixtures/tool_guard_parity.json
as evaluated by the Python guard (zn_gate.guard). The Node.js side prints the same
shape from test/helpers/export_tool_guard.js and the two must match.

Usage: PYTHONPATH=<zn-gate-py>/src python3 py_tool_guard.py [cases.json]
"""
import json
import sys
from pathlib import Path

from zn_gate.guard import check_tool_call, check_tool_result

default = Path(__file__).resolve().parent.parent / "fixtures" / "tool_guard_parity.json"
cases = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else default).read_text(encoding="utf8"))


def pick(a):
    return {"verdict": a.verdict, "rule": a.rule}


json.dump({
    "calls": [pick(check_tool_call(c["tool"], c["args"])) for c in cases["calls"]],
    "results": [pick(check_tool_result(c["result"])) for c in cases["results"]],
}, sys.stdout)
