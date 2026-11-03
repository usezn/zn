"""Differential check of the secret redaction against the Node.js package.

packages/zn-gate/test/fixtures/scrub_differential_corpus.json holds generated texts (fake keys assigned,
JSON-escaped, in a URL query or a header, split by empty quote pairs, written with percent-encoding or
broken by an invisible character) and the text redactSecrets and redactScanSecrets (lib/rules.js) return for
each. redact_secrets and redact_scan_secrets must return exactly the same text for every one of them. The
corpus comes from the seeded generator packages/zn-gate/test/helpers/scrub_corpus.js (node ... --write), and
test/scrub_differential.test.js checks it against the generator. Fake values only; every string is stored
base64-encoded (UTF-8) so the file holds no key-shaped text, and is decoded here.
"""

import base64
import json
import unittest
from pathlib import Path

from zn_gate.rules import redact_scan_secrets, redact_secrets

CORPUS = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "scrub_differential_corpus.json"


class ScrubDifferentialTests(unittest.TestCase):
    def test_both_pairs_return_the_text_of_the_corpus(self) -> None:
        if not CORPUS.exists():
            self.skipTest("packages/zn-gate is not next to this package")
        corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
        cases = [[None if s is None else base64.b64decode(s).decode("utf-8") for s in c] for c in corpus["cases"]]
        self.assertEqual(len(cases), corpus["count"])
        self.assertGreaterEqual(len(cases), 2000)
        bad = []
        changed = 0
        for text, secrets, scanned in cases:
            want = text if secrets is None else secrets
            want_scan = want if scanned is None else scanned
            if want != text:
                changed += 1
            got = redact_secrets(text)[0]
            got_scan = redact_scan_secrets(text)[0]
            if got != want:
                bad.append(("redact_secrets", text, want, got))
            if got_scan != want_scan:
                bad.append(("redact_scan_secrets", text, want_scan, got_scan))
        self.assertEqual(len(bad), 0, "%d differ, first: %r" % (len(bad), bad[:1]))
        self.assertGreater(changed, len(cases) // 2)


if __name__ == "__main__":
    unittest.main()
