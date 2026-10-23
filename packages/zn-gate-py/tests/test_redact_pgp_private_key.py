"""An OpenPGP private key ("-----BEGIN PGP PRIVATE KEY BLOCK-----") is redacted like a
PEM key: in redact_secrets, in the evidence ledger preview and in `zn-gate scan`. The key
is invented and assembled at runtime."""

import argparse
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from zn_gate import rules
from zn_gate.cli import cmd_scan
from zn_gate.evidence import log_evidence

BEGIN = "-----BEGIN PGP " + "PRIVATE KEY BLOCK-----"
END = "-----END PGP " + "PRIVATE KEY BLOCK-----"
LINE1 = "lQOYBGZNTESTFAKE" + "x" * 20 + "EXAMPLEONLY"
LINE2 = "ZNTESTFAKEpgp" + "q" * 8
KEY = BEGIN + "\n\n" + LINE1 + "\n" + LINE2 + "\n=abcd\n" + END
PIECES = [LINE1[:16], LINE2, "=abcd"]


class TestPgpPrivateKey(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_redact_secrets_replaces_the_block(self):
        out, _ = rules.redact_secrets("key:\n" + KEY + "\ndone\n")
        self.assertIn("[REDACTED_PRIVATE_KEY]", out)
        for p in PIECES:
            self.assertNotIn(p, out)
        self.assertTrue(out.endswith("\ndone\n"))

    def test_evidence_preview_hides_the_key(self):
        path = os.path.join(self.dir, "evidence.jsonl")
        log_evidence({"payload": KEY, "tool_name": "bash"}, file_path=path)
        with open(path, encoding="utf-8") as f:
            rec = json.loads(f.read().strip().splitlines()[-1])
        self.assertIn("[REDACTED_PRIVATE_KEY]", rec["payload_preview"])
        for p in PIECES:
            self.assertNotIn(p, rec["payload_preview"])

    def test_scan_reports_once_without_printing_the_key(self):
        with open(os.path.join(self.dir, "key.md"), "w", encoding="utf-8", newline="") as f:
            f.write("x = 1\n" + KEY + "\n")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cmd_scan(argparse.Namespace(path=self.dir, exclude=None, include=None, format="json", no_fail=False))
        text = out.getvalue()
        self.assertEqual(code, 1, text)
        data = json.loads(text)
        hits = [t for t in data["threats"] if t["rule"] == "secret:private_key"]
        self.assertEqual(len(hits), 1, text)
        for p in PIECES:
            self.assertNotIn(p, text)


if __name__ == "__main__":
    unittest.main()
