"""
`zn-gate analyze` takes its text as a positional argument only. It has no
--file option: passing one exits 2 with a usage block and an "unrecognized
arguments" message, and nothing is analyzed. Runs the real CLI in a child
process.
"""

import os
import subprocess
import sys
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def _run(*args):
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    env.pop("ZN_CLOUD", None)
    return subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", *args],
        capture_output=True, text=True, env=env, timeout=60,
    )


class TestAnalyzeHasNoFileOption(unittest.TestCase):
    def test_file_option_exits_2_with_usage(self):
        proc = _run("analyze", "--file", "prompt.txt")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage:", proc.stderr)
        self.assertIn("unrecognized arguments: --file", proc.stderr)
        self.assertEqual(proc.stdout, "")
        self.assertNotIn("Traceback", proc.stderr)

    def test_missing_text_is_a_usage_error(self):
        proc = _run("analyze")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("the following arguments are required: text", proc.stderr)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
