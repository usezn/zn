"""Path separators of Windows, hidden elements, openssl decode forms and
characters without a fold mapping. The cases are shared with the Node test
(test/rules_r3_r6.test.js)."""

import json
import unittest
from pathlib import Path

from zn_gate import rules

CASES_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "rules_r3_r6_cases.json"
CASES = json.loads(CASES_FILE.read_text(encoding="utf-8"))


class RulesR3R6Tests(unittest.TestCase):
    def test_sensitive_files_with_windows_and_mixed_separators(self):
        for text in CASES["sensitive_file"]["positives"]:
            r = rules.evaluate(text)
            self.assertEqual(r.verdict, "block", text)
            self.assertEqual(r.rule, "path:sensitive_file", text)
        for text in CASES["sensitive_file"]["benign"]:
            self.assertNotEqual(rules.evaluate(text).rule, "path:sensitive_file", text)

    def test_hidden_tag_needs_a_really_hidden_element(self):
        for text in CASES["hidden_tag"]["positives"]:
            self.assertTrue(rules._test_hidden_tag(text), text)
        for text in CASES["hidden_tag"]["benign"]:
            self.assertFalse(rules._test_hidden_tag(text), text)

    def test_hidden_element_with_payload_blocks(self):
        for text in CASES["hidden_tag"]["positives"]:
            self.assertEqual(rules.evaluate(text).verdict, "block", text)

    def test_openssl_is_a_decoder_only_in_decode_forms(self):
        payload = CASES["openssl"]["payload"]
        for form in CASES["openssl"]["decode"]:
            r = rules.evaluate("echo %s | %s" % (payload, form))
            self.assertEqual(r.verdict, "block", form)
            self.assertEqual(r.rule, "evasion:base64_smuggling", form)
        for form in CASES["openssl"]["not_decode"]:
            r = rules.evaluate("echo %s | %s" % (payload, form))
            self.assertNotEqual(r.rule, "evasion:base64_smuggling", form)

    def test_character_without_fold_mapping_is_kept(self):
        for text in CASES["compat_fold"]["kept"]:
            _, stripped = rules.normalize_input(text)
            self.assertEqual(stripped, text)
        for text, folded in CASES["compat_fold"]["folded"]:
            self.assertEqual(rules.normalize_input(text)[1], folded)


if __name__ == "__main__":
    unittest.main()
