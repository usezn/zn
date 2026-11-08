"""zn-gate scan --format github prints one ::error line per finding.

Two findings in two lines give exactly two annotation lines, each on its own line number.
Secrets are invented values assembled at runtime.
"""

import argparse
import io
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

from zn_gate.cli import cmd_scan

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"
FAKE_STRIPE = "sk_" + "live_" + "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4"


class TestGithubOneAnnotationPerFinding(unittest.TestCase):
    def test_two_findings_give_two_error_lines(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "notes.md"), "w", encoding="utf-8") as f:
                f.write("aws = " + FAKE_AWS + "\n" + "stripe = " + FAKE_STRIPE + "\n")
            buf = io.StringIO()
            with redirect_stdout(buf):
                cmd_scan(argparse.Namespace(path=d, exclude=None, include=None, format="github", no_fail=True))
            out = buf.getvalue()
            errors = [ln for ln in out.splitlines() if ln.startswith("::error ")]
            self.assertEqual(len(errors), 2, out)
            lines = sorted(int(ln.split("line=", 1)[1].split(",", 1)[0]) for ln in errors)
            self.assertEqual(lines, [1, 2], out)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
