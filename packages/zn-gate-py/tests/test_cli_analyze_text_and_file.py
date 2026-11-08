"""
`zn-gate analyze` takes its text as an argument only: a --file option does not
exist, so giving text and --file together is a usage error. That is exit 2
from argparse, with nothing on stdout (exit 2 is also the code for a blocked
text, so the stderr message is what tells the two apart). No network is used:
cloud mode is off in the child process.
"""

import os
import subprocess
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
TEXT = "Please summarize the quarterly revenue report."


def _run(*args):
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    for name in ("ZN_CLOUD", "ZN_API_KEY", "ZN_API_URL", "ZN_STAGE"):
        env.pop(name, None)
    return subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", "analyze", *args],
        capture_output=True, text=True, env=env, timeout=60,
    )


class TestAnalyzeTextAndFile(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(TEXT + "\n")

    def tearDown(self):
        os.remove(self.path)

    def test_text_with_file_is_a_usage_error(self):
        proc = _run(TEXT, "--file", self.path, "--local-only")
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertEqual(proc.stdout, "")
        self.assertIn("unrecognized arguments: --file", proc.stderr)

    def test_text_with_file_and_no_other_option_is_a_usage_error(self):
        proc = _run(TEXT, "--file", self.path)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertEqual(proc.stdout, "")
        self.assertIn("unrecognized arguments: --file", proc.stderr)

    def test_text_alone_is_not_a_usage_error(self):
        # Control: the same text without --file is analyzed, so exit 2 above comes from the option.
        proc = _run(TEXT, "--local-only")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("unrecognized arguments", proc.stderr)
        self.assertIn('"verdict"', proc.stdout)


if __name__ == "__main__":
    unittest.main()
