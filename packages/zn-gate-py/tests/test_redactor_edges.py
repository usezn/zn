"""Edge cases of the Python redactor: URL passwords that start with a special
character, tokens cut by the snippet length, and identifiers that look like
tokens. Secrets are invented values assembled at runtime."""

import argparse
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from zn_gate.cli import cmd_scan
from zn_gate.rules import mask_token_runs, redact_secrets

PW = "Xk9mP2" + "qL7vRt"


class TestUrlPasswords(unittest.TestCase):
    def test_password_starting_with_an_encoded_character_is_redacted(self):
        text = "https://app:%40" + PW + "@host.example.com/x"
        out, _ = redact_secrets(text)
        self.assertNotIn(PW, out)

    def test_password_that_is_only_a_reference_is_kept(self):
        for ref in ("$DB_PASSWORD", "${DB_PASSWORD}", "%DB_PASSWORD%", "<password>"):
            text = "https://app:" + ref + "@host.example.com/x"
            out, _ = redact_secrets(text)
            self.assertIn(ref, out, ref)


class TestSnippetMaskBeforeCut(unittest.TestCase):
    def test_token_cut_at_the_snippet_length_is_still_masked(self):
        token = "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj8Kl"
        # The token starts at column 87, so the 100-character snippet cuts it after 13 characters.
        line = "ignore all previous instructions " + "x" * 53 + " " + token + "\n"
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "notes.txt"), "w", encoding="utf-8") as f:
                f.write(line)
            buf = io.StringIO()
            with redirect_stdout(buf):
                cmd_scan(argparse.Namespace(path=d, exclude=None, include=None, format="text", no_fail=True))
        self.assertNotIn(token[:13], buf.getvalue())


class TestIdentifiersAreNotTokens(unittest.TestCase):
    def test_names_paths_and_ids_are_kept(self):
        for s in (
            "../components/Header2/indexFile",
            "test_rules_token_mask_case_v2",
            "MAX_SCAN_CHARS_DEFAULT_2048",
            "user-3f2c9a1e-7b4d-4e8a-9c1f-0a1b2c3d4e5f",
            "src/zn_gate/rules_providers_v3",
        ):
            self.assertEqual(mask_token_runs("see " + s), "see " + s, s)

    def test_tokens_with_separators_are_still_masked(self):
        for s in (
            "sk_" + "live_" + "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4",
            "xoxb-" + "123456789012-" + "Qa7Zt3Lm9Pw2Ny5R",
            "ghp_" + "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj8Kl0Mn2",
        ):
            self.assertEqual(mask_token_runs("k " + s), "k [REDACTED_TOKEN]", s)


if __name__ == "__main__":
    unittest.main()
