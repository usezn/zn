"""Evidence ledger: file modes on POSIX, and a payload preview with no token-like runs."""

import os
import shutil
import stat
import tempfile
import unittest

from zn_gate.evidence import log_evidence, verify_evidence_ledger

POSIX = os.name == "posix"


@unittest.skipUnless(POSIX, "file modes are POSIX only")
class TestLedgerModes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zn_ev_mode_")
        self.ledger_dir = os.path.join(self.tmp, "zn")
        self.ledger = os.path.join(self.ledger_dir, "evidence.jsonl")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _log(self):
        log_evidence({"agent": "mode-test", "payload": "ok", "verdict": "allow"}, file_path=self.ledger)

    def test_new_directory_is_0700_and_new_file_is_0600(self):
        self._log()
        self.assertEqual(stat.S_IMODE(os.stat(self.ledger_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.ledger).st_mode), 0o600)

    def test_existing_world_readable_ledger_is_restricted_on_the_next_write(self):
        self._log()
        os.chmod(self.ledger, 0o644)
        self._log()
        self.assertEqual(stat.S_IMODE(os.stat(self.ledger).st_mode), 0o600)
        self.assertTrue(verify_evidence_ledger(self.ledger)["valid"])


class TestLedgerPreview(unittest.TestCase):
    def test_payload_preview_masks_token_runs_the_redactor_does_not_know(self):
        tmp = tempfile.mkdtemp(prefix="zn_ev_prev_")
        try:
            ledger = os.path.join(tmp, "evidence.jsonl")
            rec = log_evidence({"agent": "a", "payload": "note Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6 end",
                                "verdict": "allow"}, file_path=ledger)
            self.assertNotIn("Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6", rec["payload_preview"])
            self.assertIn("[REDACTED_TOKEN]", rec["payload_preview"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
