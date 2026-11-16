"""Exit codes and warnings for the cloud fallback and an invalid evidence ledger."""
import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SRC = str(Path(__file__).resolve().parents[1] / "src")


def run(args, home):
    env = dict(os.environ, ZN_HOME=home, PYTHONPATH=SRC)
    env.pop("ZN_API_KEY", None)
    return subprocess.run([sys.executable, "-m", "zn_gate.cli", *args], env=env,
                          capture_output=True, text=True, timeout=60)


class EvidenceExitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        from zn_gate.evidence import log_evidence
        self.ledger = Path(self.home) / "evidence.jsonl"
        for i in range(3):
            log_evidence({"payload": f"example-{i}", "tool_name": "bash", "verdict": "allow"},
                         file_path=str(self.ledger))

    def tamper(self):
        lines = self.ledger.read_text(encoding="utf-8").splitlines()
        self.assertGreaterEqual(len(lines), 2)
        rec = json.loads(lines[0])
        rec["verdict"] = "tampered"
        lines[0] = json.dumps(rec)
        self.ledger.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_valid_ledger_exits_0(self):
        for args in (["evidence"], ["evidence", "--export"], ["evidence", "--verify"]):
            self.assertEqual(run(args, self.home).returncode, 0, args)

    def test_tampered_ledger_exits_1(self):
        self.tamper()
        self.assertEqual(run(["evidence", "--verify"], self.home).returncode, 1)
        exp = run(["evidence", "--export"], self.home)
        self.assertEqual(exp.returncode, 1)
        self.assertIn("Tamper detected", exp.stderr)
        self.assertTrue(exp.stdout.strip())  # the records are still written out
        st = run(["evidence"], self.home)
        self.assertEqual(st.returncode, 1)
        self.assertIn("CORRUPTED", st.stdout)

    def test_export_to_file_tampered_exits_1(self):
        self.tamper()
        out = os.path.join(self.home, "out.jsonl")
        self.assertEqual(run(["evidence", "--export", "--output", out], self.home).returncode, 1)
        self.assertTrue(os.path.exists(out))


class AnalyzeFallbackWarningTest(unittest.TestCase):
    def _run(self, res):
        from zn_gate import cli
        args = argparse.Namespace(text="hi", key=None, stage=None, url=None, local_only=False, long_input=None)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(cli, "analyze", return_value=res), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.cmd_analyze(args)
        return rc, out.getvalue(), err.getvalue()

    def test_fallback_warns_on_stderr_and_exits_0(self):
        rc, out, err = self._run({"verdict": "allow", "fallback": True, "mode": "oss-local", "cloud_error": "boom"})
        self.assertEqual(rc, 0)
        self.assertIn("cloud call failed", err)
        self.assertNotIn("Warning", out)
        self.assertTrue(json.loads(out)["fallback"])

    def test_normal_result_has_no_warning(self):
        rc, out, err = self._run({"verdict": "allow", "mode": "oss-local"})
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")

    def test_degraded_keeps_its_own_warning(self):
        rc, out, err = self._run({"verdict": "allow", "degraded": True})
        self.assertIn("cloud model was unavailable", err)


if __name__ == "__main__":
    unittest.main()
