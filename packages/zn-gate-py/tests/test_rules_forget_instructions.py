"""Forget-the-instructions phrases block as pi:forget; the benign twins stay allowed.
The cases are shared with the Node.js and Rust tests (packages/zn-gate/test/fixtures/forget_instruction_cases.json)."""
import json
import unittest
from pathlib import Path

from zn_gate import rules as R

CASES_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "forget_instruction_cases.json"


@unittest.skipUnless(CASES_FILE.exists(), "needs the monorepo checkout")
class TestForgetInstructions(unittest.TestCase):
    def setUp(self):
        self.cases = json.loads(CASES_FILE.read_text(encoding="utf-8"))

    def test_attacks_block(self):
        for text in self.cases["attacks"]:
            with self.subTest(text=text):
                r = R.evaluate(text)
                self.assertEqual(r.verdict, "block")
                self.assertEqual(r.rule, "pi:forget")

    def test_benign_twins_allowed(self):
        for text in self.cases["benign"]:
            with self.subTest(text=text):
                self.assertEqual(R.evaluate(text).verdict, "allow")


if __name__ == "__main__":
    unittest.main()
