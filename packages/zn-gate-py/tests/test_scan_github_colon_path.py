"""zn-gate scan --format github: a colon in a file name is percent-encoded in the
file= property of the annotation (GitHub workflow command escaping). The secret
is an invented value assembled at runtime."""

import argparse
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

from zn_gate.cli import cmd_scan

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"


@unittest.skipIf(sys.platform == "win32", "a colon is not allowed in a Windows file name")
class TestGithubColonPath(unittest.TestCase):
    def test_colon_in_file_name_is_percent_encoded(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "a:b.txt"), "w", encoding="utf-8") as f:
                f.write("key = " + FAKE_AWS + "\n")
            buf = io.StringIO()
            with redirect_stdout(buf):
                cmd_scan(argparse.Namespace(path=d, exclude=None, include=None, format="github", no_fail=True))
        errors = [ln for ln in buf.getvalue().splitlines() if ln.startswith("::error ")]
        self.assertTrue(errors, buf.getvalue())
        for ln in errors:
            prop = ln[len("::error "):].split(",line=")[0]
            self.assertTrue(prop.startswith("file="), ln)
            self.assertIn("a%3Ab.txt", prop)
            self.assertNotIn("a:b.txt", prop)
