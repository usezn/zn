"""`zn-gate version` prints exactly one line, with no trailing whitespace.

The CLI runs as a real subprocess so the bytes written to stdout are the
ones a user (or a script that parses the version) sees.
"""

import os
import subprocess
import sys
import unittest

_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def _version_stdout() -> str:
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", "version"],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


class TestVersionLineFormat(unittest.TestCase):
    def test_version_output_is_exactly_one_newline_terminated_line(self):
        out = _version_stdout()
        self.assertTrue(out.endswith("\n"), repr(out))
        self.assertEqual(out.count("\n"), 1, repr(out))
        self.assertNotIn("\r", out)

    def test_version_line_has_no_trailing_whitespace(self):
        line = _version_stdout().rstrip("\n")
        self.assertNotEqual(line, "")
        self.assertEqual(line, line.rstrip(), repr(line))
        self.assertEqual(line, line.strip(), repr(line))


if __name__ == "__main__":
    unittest.main()
