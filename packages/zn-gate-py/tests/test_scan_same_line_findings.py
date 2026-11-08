"""zn-gate scan: two credentials on one line are two findings on that line.

A finding carries a line number and no column: the text, JSON and GitHub
formats have no column field. The column check is an expected failure until
the scan reports one. Every value is invented and assembled at runtime."""

import argparse
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from zn_gate.cli import cmd_scan

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"
FAKE_GITHUB = "gh" + "p_" + "aB3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW1xY2"
LINE = "export AWS_ACCESS_KEY_ID=" + FAKE_AWS + " GITHUB_TOKEN=" + FAKE_GITHUB


class TestTwoFindingsOnOneLine(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, "notes.md"), "w", encoding="utf-8", newline="") as f:
            f.write("first line\n" + LINE + "\nthird line\n")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _scan(self, fmt):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cmd_scan(argparse.Namespace(path=self.dir, exclude=None, include=None, format=fmt, no_fail=False))
        return code, out.getvalue()

    def _secrets(self):
        code, out = self._scan("json")
        data = json.loads(out)
        return code, [t for t in data["threats"] if t["type"] == "secret_leak"], out

    def test_both_secrets_are_reported_on_the_line_they_share(self):
        code, found, _ = self._secrets()
        self.assertEqual(code, 1)
        self.assertEqual(len(found), 2)
        self.assertEqual({t["line"] for t in found}, {2})
        self.assertEqual(len({t["rule"] for t in found}), 2)

    def test_no_value_is_printed_in_any_format(self):
        for fmt in ("text", "json", "github"):
            with self.subTest(format=fmt):
                _, out = self._scan(fmt)
                self.assertNotIn(FAKE_AWS, out)
                self.assertNotIn(FAKE_GITHUB, out)

    @unittest.expectedFailure
    def test_each_finding_has_its_own_column(self):
        # Known gap: the scan reports the line only, so two findings on one line
        # cannot be told apart by position. Remove the expectedFailure marker
        # when a column field is added to the JSON findings.
        _, found, _ = self._secrets()
        columns = [t.get("column") for t in found]
        self.assertTrue(all(isinstance(c, int) for c in columns), columns)
        self.assertEqual(len(set(columns)), len(columns), columns)


if __name__ == "__main__":
    unittest.main()
