"""zn-gate scan does not read .gitignore: a file that a .gitignore lists is still
scanned, and a secret in it is still reported. The key is invented and built at
runtime, so no literal key appears in this file."""

import argparse
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

from zn_gate.cli import cmd_scan

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"


class ScanDoesNotFollowGitignoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, name, text):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def test_file_listed_in_gitignore_is_scanned_and_its_key_reported(self):
        self._write(".gitignore", "secrets.env\n")
        self._write("secrets.env", "AWS_ACCESS_KEY_ID=" + FAKE_AWS + "\n")
        out = io.StringIO()
        with redirect_stdout(out):
            code = cmd_scan(argparse.Namespace(path=self.dir, exclude=None, include=None, format="json", no_fail=False))
        data = json.loads(out.getvalue())
        self.assertEqual(code, 1)
        leaks = [t for t in data["threats"] if t["type"] == "secret_leak"]
        self.assertTrue(any(t["file"].endswith("secrets.env") for t in leaks), data["threats"])
        self.assertNotIn(FAKE_AWS, out.getvalue())


if __name__ == "__main__":
    unittest.main()
