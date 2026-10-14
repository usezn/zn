"""zn-gate scan and test output: GitHub format carries no snippet, and the text
and JSON snippets never show a token-like run that survived redaction.
Secrets are invented values assembled at runtime."""

import argparse
import io
import json
import os
import shutil
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


def pathlib_name(p):
    return os.path.basename(p)


class TestScanSkipped(unittest.TestCase):
    def _dir(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "big.md"), "w", encoding="utf-8") as f:
            f.write("x" * (2 * 1024 * 1024))
        with open(os.path.join(d, "slides.key"), "wb") as f:
            f.write(b"PK" + b"\0" * 16)
        with open(os.path.join(d, "ok.md"), "w", encoding="utf-8") as f:
            f.write("hello there, nothing to see\n")
        return d

    def _run(self, d, fmt):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cmd_scan(argparse.Namespace(path=d, exclude=None, include=None, format=fmt, no_fail=False))
        return code, buf.getvalue()

    def test_json_lists_skipped_files(self):
        d = self._dir()
        try:
            code, out = self._run(d, "json")
            data = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(data["total_files"], 1)
            self.assertEqual(data["total_skipped"], 2)
            reasons = sorted(s["reason"] for s in data["skipped"])
            self.assertEqual(reasons, ["2 MiB or larger", "binary .key file, not a key"])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_github_annotations_cannot_be_forged_by_a_file_name(self):
        d = tempfile.mkdtemp()
        try:
            name = "evil\n::error file=x::forged,title=Z.md"
            try:
                with open(os.path.join(d, name), "w", encoding="utf-8") as f:
                    f.write("x" * (2 * 1024 * 1024))
            except OSError:
                self.skipTest("this file system does not allow a newline in a file name")
            _, gh = self._run(d, "github")
            commands = [ln for ln in gh.splitlines() if ln.startswith("::")]
            self.assertEqual(len(commands), 1, gh)
            self.assertTrue(commands[0].startswith("::notice file="))
            self.assertIn("%0A%3A%3Aerror file=x%3A%3Aforged%2Ctitle=Z.md", commands[0])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_unreadable_and_special_files_are_reported(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "ok.md"), "w", encoding="utf-8") as f:
                f.write("hello there\n")
            if hasattr(os, "mkfifo"):
                os.mkfifo(os.path.join(d, "pipe.md"))
            data = json.loads(self._run(d, "json")[1])
            reasons = {pathlib_name(s["file"]): s["reason"] for s in data["skipped"]}
            if hasattr(os, "mkfifo"):
                self.assertEqual(reasons.get("pipe.md"), "not a regular file")
            self.assertEqual(data["total_files"], 1)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_text_and_github_mention_skipped_files(self):
        d = self._dir()
        try:
            _, text = self._run(d, "text")
            self.assertIn("Not scanned (2):", text)
            self.assertIn("(2 MiB or larger)", text)
            _, gh = self._run(d, "github")
            self.assertEqual(len([ln for ln in gh.splitlines() if ln.startswith("::notice ")]), 2)
            self.assertIn("(2 not scanned)", gh)
        finally:
            shutil.rmtree(d, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
