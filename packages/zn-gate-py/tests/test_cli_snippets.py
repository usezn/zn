"""zn-gate scan and test output: GitHub format carries no snippet, and the text
and JSON snippets never show a token-like run that survived redaction.
Secrets are invented values assembled at runtime."""

import argparse
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from zn_gate.cli import cmd_scan, cmd_test

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"
# A token the redactor does not know, with letters and digits (masked for display).
UNKNOWN_TOKEN = "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6"


def _scan(text, fmt):
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, ".env"), "w", encoding="utf-8") as f:
            f.write(text)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cmd_scan(argparse.Namespace(path=d, exclude=None, include=None, format=fmt, no_fail=False))
    return code, buf.getvalue()


class TestScanSnippets(unittest.TestCase):
    LINE = f"AWS_ACCESS_KEY_ID={FAKE_AWS} extra {UNKNOWN_TOKEN}\n"

    def test_github_format_prints_rule_reason_and_location_only(self):
        code, out = _scan(self.LINE, "github")
        self.assertEqual(code, 1)
        error_lines = [ln for ln in out.splitlines() if ln.startswith("::error ")]
        self.assertTrue(error_lines)
        for ln in error_lines:
            self.assertIn("file=", ln)
            self.assertIn("line=1", ln)
            self.assertNotIn(" in: ", ln)
        self.assertNotIn(FAKE_AWS, out)
        self.assertNotIn(UNKNOWN_TOKEN, out)
        self.assertNotIn("AWS_ACCESS_KEY_ID", out)

    def test_json_content_masks_token_runs_left_after_redaction(self):
        _, out = _scan(self.LINE, "json")
        threats = json.loads(out)["threats"]
        self.assertTrue(threats)
        for t in threats:
            self.assertNotIn(FAKE_AWS, t["content"])
            self.assertNotIn(UNKNOWN_TOKEN, t["content"])
            self.assertIn("[REDACTED_TOKEN]", t["content"])

    def test_text_snippet_masks_token_runs(self):
        _, out = _scan(self.LINE, "text")
        self.assertNotIn(UNKNOWN_TOKEN, out)
        self.assertNotIn(FAKE_AWS, out)


class TestTestCommandMasking(unittest.TestCase):
    def test_redacted_output_masks_unknown_tokens(self):
        text = f"AWS_ACCESS_KEY_ID={FAKE_AWS} note {UNKNOWN_TOKEN}"
        buf = io.StringIO()
        with redirect_stdout(buf):
            cmd_test(argparse.Namespace(text=text, json=False))
        out = buf.getvalue()
        self.assertIn("DLP Alert:", out)
        self.assertNotIn(FAKE_AWS, out)
        self.assertNotIn(UNKNOWN_TOKEN, out)

    def test_json_redacted_preview_masks_unknown_tokens(self):
        text = f"AWS_ACCESS_KEY_ID={FAKE_AWS} note {UNKNOWN_TOKEN}"
        buf = io.StringIO()
        with redirect_stdout(buf):
            cmd_test(argparse.Namespace(text=text, json=True))
        preview = json.loads(buf.getvalue())["redacted_preview"]
        self.assertNotIn(UNKNOWN_TOKEN, preview)
        self.assertNotIn(FAKE_AWS, preview)


if __name__ == "__main__":
    unittest.main()
