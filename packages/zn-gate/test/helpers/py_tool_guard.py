"""Prints the verdict, rule id and rules version of every case in test/fixtures/tool_guard_parity.json
as evaluated by the Python guard (zn_gate.guard). The Node.js side prints the same
shape from test/helpers/export_tool_guard.js and the two must match.

Usage: PYTHONPATH=<zn-gate-py>/src python3 py_tool_guard.py [cases.json]
"""
import json
import sys
import types
from pathlib import Path

from zn_gate.guard import check_tool_call, check_tool_result

default = Path(__file__).resolve().parent.parent / "fixtures" / "tool_guard_parity.json"


def build(v):
    """Structures JSON cannot hold, described by a "$build" key (same shapes as export_tool_guard.js)."""
    if not isinstance(v, dict) or "$build" not in v:
        return v
    kind, leaf = v["$build"], v.get("leaf")
    if kind == "nest":
        x = leaf
        for _ in range(v["levels"]):
            x = {"a": [x]}
        return x
    if kind == "map":
        return {"x": types.MappingProxyType({"k": types.MappingProxyType({"p": leaf})})}
    if kind == "bytes":
        return {"p": leaf.encode()}
    if kind == "cycle":
        d = {"k": "hello"}
        d["self"] = d
        lst = [d]
        lst.append(lst)
        if leaf != "hello":
            d["bad"] = leaf
        return lst
    raise ValueError("unknown $build " + kind)


def pick(a):
    return {"verdict": a.verdict, "rule": a.rule, "rules_version": a.rules_version}


if __name__ == "__main__":
    cases = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else default).read_text(encoding="utf8"))
    json.dump({
        "calls": [pick(check_tool_call(c["tool"], build(c["args"]))) for c in cases["calls"]],
        "results": [pick(check_tool_result(build(c["result"]))) for c in cases["results"]],
    }, sys.stdout)
