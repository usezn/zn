"""path:sensitive_file on the table shared with the Node.js package.

The table lives in packages/zn-gate/test/fixtures/sensitive_path_cases.json;
the test is skipped when that package is not next to this one (an sdist).
"""

import json
import time
import unittest
from pathlib import Path

from zn_gate import check_tool_call
from zn_gate.rules import sensitive_path_view

CASES_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "sensitive_path_cases.json"


class TestSensitivePathTable(unittest.TestCase):
    def test_shared_table(self):
        if not CASES_FILE.is_file():
            self.skipTest("packages/zn-gate is not next to this package")
        cases = json.loads(CASES_FILE.read_text(encoding="utf-8"))["cases"]
        for case in cases:
            p, expect = case["path"], case["expect"]
            for tool, args in (("read_file", {"path": p}), ("shell", {"command": "cat " + p})):
                with self.subTest(tool=tool, path=p):
                    res = check_tool_call(tool, args)
                    if expect == "block":
                        self.assertEqual(res.rule, "path:sensitive_file")
                    else:
                        # Other rules may still flag a shell command (for example
                        # "cat" of an .env template); this table checks the path rule.
                        self.assertNotEqual(res.rule, "path:sensitive_file")
                        # An .env template is not a credential for any rule, in a shell command too.
                        if tool == "read_file" or case["kind"] == "template":
                            self.assertEqual(res.verdict, "allow", res.rule)


class TestSensitivePathView(unittest.TestCase):
    def test_lexical(self):
        self.assertEqual(sensitive_path_view("a/b/../../../c"), "../c")
        self.assertEqual(sensitive_path_view("/../x"), "/x")
        self.assertEqual(sensitive_path_view("C:\\A\\..\\..\\b"), "c:/b\nc:a....b")
        self.assertEqual(sensitive_path_view("~user/./x//y"), "~/x/y")

    def test_linear(self):
        long = "." * 200000 + "x " + "/.." * 50000 + " " + "\\" * 100000
        t0 = time.perf_counter()
        sensitive_path_view(long)
        self.assertLess(time.perf_counter() - t0, 1.0)


if __name__ == "__main__":
    unittest.main()
