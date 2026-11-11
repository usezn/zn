"""zn-gate scan --format github prints no ANSI escape sequences, even when
FORCE_COLOR is set and NO_COLOR is not. The child process writes to a pipe,
not a terminal. The secret is an invented value assembled at runtime."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"


def _run_scan(path):
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["FORCE_COLOR"] = "1"
    env.pop("NO_COLOR", None)
    env.pop("TERM", None)
    env.pop("CI", None)
    return subprocess.run(
        [sys.executable, "-m", "zn_gate", "scan", path, "--format", "github"],
        capture_output=True, env=env, timeout=120,
    )


class TestScanGithubNoAnsi(unittest.TestCase):
    def test_github_format_has_no_escape_sequences_with_force_color(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "config.txt").write_text(f"aws_key = {FAKE_AWS}\n", encoding="utf-8")
            proc = _run_scan(d)
        out = proc.stdout.decode("utf-8", errors="replace")
        self.assertIn("::error ", out, out + proc.stderr.decode("utf-8", errors="replace"))
        self.assertNotIn("\x1b[", out)
        self.assertNotIn("\x1b", out)
        self.assertNotIn(FAKE_AWS, out)


if __name__ == "__main__":
    unittest.main()
