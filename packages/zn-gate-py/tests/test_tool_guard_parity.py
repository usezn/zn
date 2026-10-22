"""The Python guard must give the same verdicts as the Node.js guard in packages/zn-gate.

The Node.js side is printed as JSON by packages/zn-gate/test/helpers/export_tool_guard.js
for the cases in packages/zn-gate/test/fixtures/tool_guard_parity.json. These tests need
the monorepo checkout and a `node` binary; they are skipped with a message when either
is missing (for example when testing an sdist).
"""

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate.guard import check_tool_call, check_tool_result

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
EXPORT_SCRIPT = NODE_PKG / "test" / "helpers" / "export_tool_guard.js"
CASES_FILE = NODE_PKG / "test" / "fixtures" / "tool_guard_parity.json"
PY_HELPER = NODE_PKG / "test" / "helpers" / "py_tool_guard.py"


def _build():
    spec = importlib.util.spec_from_file_location("py_tool_guard", PY_HELPER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.build


def _node_export():
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed: skipping the Node.js/Python guard parity check")
    if not EXPORT_SCRIPT.is_file() or not CASES_FILE.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the guard parity check")
    with tempfile.TemporaryDirectory() as empty:
        out = subprocess.run([node, str(EXPORT_SCRIPT)], cwd=empty, check=True, capture_output=True, timeout=120).stdout
    return json.loads(out.decode("utf8"))


class ToolGuardParityTest(unittest.TestCase):
    def test_verdicts_match_node(self):
        js = _node_export()
        build = _build()
        cases = json.loads(CASES_FILE.read_text(encoding="utf8"))
        py_calls = [{"verdict": a.verdict, "rule": a.rule, "rules_version": a.rules_version} for a in (check_tool_call(c["tool"], build(c["args"])) for c in cases["calls"])]
        py_results = [{"verdict": a.verdict, "rule": a.rule, "rules_version": a.rules_version} for a in (check_tool_result(build(c["result"])) for c in cases["results"])]
        self.assertEqual(js["calls"], py_calls)
        self.assertEqual(js["results"], py_results)


if __name__ == "__main__":
    unittest.main()
