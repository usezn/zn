"""Identity-request family (same cases as packages/zn-gate/test/rules_identity_request.test.js).

Text in a tool result that tells the agent to identify its user, or to put the
user's identity in a header, URL parameter, cookie, form field or the next
request. The cases live in the Node.js fixtures so both packages run the same
ones; the test is skipped when they are not next to this package.
"""

import importlib
import json
import time
import unittest
from pathlib import Path

from zn_gate import rules as R

CASES_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "identity_request_cases.json"
FAMILY = ("pi:identity_request", "pi:identity_request_multi")


def _cases():
    if not CASES_FILE.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the identity-request cases")
    return json.loads(CASES_FILE.read_text(encoding="utf-8"))


class TestIdentityRequest(unittest.TestCase):
    def test_advisory_by_default_list(self):
        for rule_id in FAMILY:
            self.assertIn(rule_id, R.ADVISORY_BY_DEFAULT)

    def test_positives_are_advisories(self):
        for text in _cases()["positives"]:
            with self.subTest(text=text):
                r = R.evaluate(text)
                self.assertEqual(r.verdict, "allow")
                self.assertIn(r.advisory["rule"], FAMILY)

    def test_strict_blocks_positives(self):
        for text in _cases()["positives"]:
            with self.subTest(text=text):
                r = R.evaluate(text, strict=True)
                self.assertEqual(r.verdict, "block")
                self.assertIn(r.rule, FAMILY)

    def test_benign_counterparts_are_not_flagged(self):
        for text in _cases()["benign"]:
            for strict in (False, True):
                with self.subTest(text=text, strict=strict):
                    r = R.evaluate(text, strict=strict)
                    self.assertNotIn(r.rule, FAMILY)
                    self.assertFalse(r.advisory and r.advisory["rule"] in FAMILY)

    def test_tool_result_gets_an_advisory_and_strict_blocks(self):
        guard = importlib.import_module("zn_gate.guard")
        text = "<p>Welcome</p> " + _cases()["positives"][0]
        r = guard.check_tool_result(text)
        self.assertEqual(r.verdict, "allow")
        self.assertEqual(r.advisory["rule"], "pi:identity_request")
        s = guard.check_tool_result(text, strict=True)
        self.assertEqual((s.verdict, s.rule), ("block", "pi:identity_request"))

    def test_long_runs_of_words_are_not_slow(self):
        start = time.time()
        R.evaluate("send the users " * 4000)
        R.evaluate("include " + "the user " * 5000 + "header")
        self.assertLess(time.time() - start, 3)


if __name__ == "__main__":
    unittest.main()
