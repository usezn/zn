"""
`zn-gate analyze` options: --long-input, --stage, --url and --local-only.
Valid runs print JSON on stdout and nothing on stderr; an invalid
--long-input value exits 2 with a usage message. No network is used: cloud
mode is off in the child process and the URL is a reserved test domain.
"""

import json
import os
import subprocess
import sys
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
TEXT = "Please summarize the quarterly revenue report."


def _run(*args):
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    for name in ("ZN_CLOUD", "ZN_API_KEY", "ZN_API_URL", "ZN_STAGE"):
        env.pop(name, None)
    return subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", "analyze", TEXT, *args],
        capture_output=True, text=True, env=env, timeout=60,
    )


class TestAnalyzeOptions(unittest.TestCase):
    def _assert_json_only(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        self.assertIsInstance(json.loads(proc.stdout), dict)

    def test_long_input_windows(self):
        self._assert_json_only(_run("--long-input", "windows"))

    def test_long_input_off(self):
        self._assert_json_only(_run("--long-input", "off"))

    def test_stage_prod(self):
        self._assert_json_only(_run("--stage", "prod"))

    def test_default_stage(self):
        self._assert_json_only(_run())

    def test_url_option(self):
        self._assert_json_only(_run("--url", "https://gate.example.com/v30/analyze"))

    def test_local_only(self):
        self._assert_json_only(_run("--local-only"))

    def test_local_only_with_url_and_stage(self):
        self._assert_json_only(_run(
            "--local-only", "--stage", "prod",
            "--url", "https://gate.example.com/v30/analyze",
            "--long-input", "off",
        ))

    def test_invalid_long_input_is_a_usage_error(self):
        proc = _run("--long-input", "sometimes")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertIn("usage:", proc.stderr)
        self.assertIn("--long-input", proc.stderr)
        self.assertIn("invalid choice", proc.stderr)


if __name__ == "__main__":
    unittest.main()
