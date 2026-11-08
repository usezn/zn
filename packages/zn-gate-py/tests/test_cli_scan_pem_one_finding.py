"""
`zn-gate scan` on a file that holds one PEM private key block reports exactly
one finding for the whole block, and never prints the key body. Runs the real
CLI in a child process, both on a file path and on its folder. All key
material here is fake.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
BEGIN = "-----BEGIN " + "PRIVATE KEY-----"
END = "-----END " + "PRIVATE KEY-----"
BODY_1 = "FAKEKEYBODY0001ABCDEFGHIJKLMNOPQRSTUV"
BODY_2 = "FAKEKEYBODY0002WXYZ0123456789ABCDEFGH"


def _run(*args, cwd):
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    env.pop("ZN_CLOUD", None)
    return subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", *args],
        capture_output=True, text=True, env=env, cwd=cwd, timeout=60,
    )


class TestPemBlockIsOneFinding(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.dir = self._dir.name
        self.path = os.path.join(self.dir, "deploy_key.pem")
        text = "x = 1\n" + BEGIN + "\n" + BODY_1 + "\n" + BODY_2 + "\n" + END + "\n"
        with open(self.path, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def tearDown(self):
        self._dir.cleanup()

    def _assert_one_key_finding(self, proc):
        self.assertNotIn("Traceback", proc.stderr)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertNotIn(BODY_1, proc.stdout)
        self.assertNotIn(BODY_2, proc.stdout)
        threats = json.loads(proc.stdout)["threats"]
        key_findings = [t for t in threats if t["rule"] == "secret:private_key"]
        self.assertEqual(len(key_findings), 1)
        self.assertEqual(len(threats), 1)
        self.assertEqual(key_findings[0]["line"], 2)

    def test_scan_of_the_file_reports_one_finding(self):
        self._assert_one_key_finding(_run("scan", self.path, "--format", "json", cwd=self.dir))

    def test_scan_of_the_folder_reports_one_finding(self):
        self._assert_one_key_finding(_run("scan", self.dir, "--format", "json", cwd=self.dir))


if __name__ == "__main__":
    unittest.main()
