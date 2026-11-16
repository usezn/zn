"""Spanish, French, German and Portuguese override rules (Python side).

The cases are shared with the Node.js test (override_langs_cases.json in
packages/zn-gate/test/fixtures). The test is skipped when the monorepo
fixture is missing (for example when testing an sdist).
"""

import json
import unittest
from pathlib import Path

from zn_gate.rules import evaluate

CASES_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "override_langs_cases.json"


@unittest.skipUnless(CASES_FILE.exists(), "monorepo fixture not available")
class OverrideLangsTests(unittest.TestCase):
    def setUp(self):
        self.cases = json.loads(CASES_FILE.read_text(encoding="utf-8"))

    def test_canonical_phrases_block(self):
        for lang, case in self.cases.items():
            for text in case["attacks"]:
                with self.subTest(lang=lang, text=text):
                    res = evaluate(text)
                    self.assertEqual(res.verdict, "block")
                    self.assertEqual(res.rule, case["rule"])

    def test_benign_sentences_allow(self):
        for lang, case in self.cases.items():
            for text in case["benign"]:
                with self.subTest(lang=lang, text=text):
                    res = evaluate(text)
                    self.assertEqual(res.verdict, "allow", res.rule)

    def test_phrase_inside_longer_text(self):
        for lang, case in self.cases.items():
            for text in case["attacks"]:
                with self.subTest(lang=lang, text=text):
                    res = evaluate("Notes for the build.\nThanks for your help.\n" + text + "\nEnd of file.")
                    self.assertEqual(res.verdict, "block")


if __name__ == "__main__":
    unittest.main()
