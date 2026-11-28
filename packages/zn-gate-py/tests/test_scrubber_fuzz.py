"""Fuzz corpus and fixed-seed slice for the secret scrubbers (Python and Node.js).

The large seeded fuzz (tests/fuzz_scrubber_at_scale.py) splits fake provider keys with newlines, tabs,
quotes, Unicode separators and escapes, at random widths, inside JSON, YAML, shell and markdown text.
Every failure class it found is a case in test/fixtures/scrubber_fuzz_corpus.json. Each case wants
"fully redacted, same output in both engines"; the fields node_remnant, python_remnant and mismatch
record what is still wrong today (known gaps, fixed in follow-up work). A case whose state changes
fails here, in both directions, so a fix must flip the field and the list cannot go stale.

The slice test runs a small fixed-seed part of the fuzz and fails when it gets worse than the recorded
ceilings. These tests need the monorepo checkout and a `node` binary; they are skipped otherwise.
"""

import json
import os
import shutil
import unittest
from pathlib import Path

from zn_gate.rules import redact_secrets

from . import scrub_fuzz_gen as G

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
CORPUS = NODE_PKG / "test" / "fixtures" / "scrubber_fuzz_corpus.json"
HAVE_NODE = shutil.which("node") is not None and CORPUS.exists()
# In CI the corpus and slice tests must run: without node or the fixture they fail there instead of skipping.
RUN_NODE_TESTS = HAVE_NODE or bool(os.environ.get("CI"))

# Ceilings for the fixed-seed slice (SLICE_SEED, SLICE_PER_PROVIDER). Lower them when a fix lands.
# This is a ratchet on known split-key leaks (tracked as their own fixes): the slice only bounds the totals, and
# FuzzCorpus fails on any single corpus case whose state changes, in either direction.
SLICE_SEED = "split-keys-ci"
SLICE_PER_PROVIDER = 6
MAX_REMNANT_NODE = 68
MAX_REMNANT_PYTHON = 68
# The mismatches left are extra redaction only: one engine also takes part of the next line after a key (no key text is left).
MAX_MISMATCH = 0


def _node(texts):
    from .fuzz_scrubber_at_scale import node_batch
    return node_batch(texts)


@unittest.skipUnless(RUN_NODE_TESTS, "needs the monorepo checkout and node")
class FuzzCorpus(unittest.TestCase):
    def test_every_case_is_in_its_recorded_state(self):
        corpus = json.loads(CORPUS.read_text(encoding="utf8"))
        self.assertGreater(len(corpus), 100)
        node = _node(["".join(c["text_parts"]) for c in corpus])
        for c, n in zip(corpus, node, strict=True):
            with self.subTest(case=c["id"]):
                self.assertIn("out", n, "node crashed")
                py = redact_secrets("".join(c["text_parts"]))[0]
                case = {"key": "".join(c["secret_parts"]), "body_off": 0}
                self.assertEqual(bool(G.remnant(case, py)), c["python_remnant"], "python state changed: update the corpus")
                self.assertEqual(bool(G.remnant(case, n["out"])), c["node_remnant"], "node state changed: update the corpus")
                self.assertEqual(py != n["out"], c["mismatch"], "parity state changed: update the corpus")


@unittest.skipUnless(RUN_NODE_TESTS, "needs the monorepo checkout and node")
class FuzzSlice(unittest.TestCase):
    def test_generator_is_deterministic(self):
        a = [c["text"] for c in G.cases(SLICE_SEED, 2)]
        b = [c["text"] for c in G.cases(SLICE_SEED, 2)]
        self.assertEqual(a, b)
        self.assertEqual(len(G.PROVIDER_NAMES) * 2, len(a))

    def test_slice_does_not_get_worse(self):
        cases = list(G.cases(SLICE_SEED, SLICE_PER_PROVIDER))
        node = _node([c["text"] for c in cases])
        rn = rp = mm = 0
        for c, n in zip(cases, node, strict=True):
            self.assertIn("out", n, "node crashed on seed " + c["seed"])
            py = redact_secrets(c["text"])[0]
            rn += bool(G.remnant(c, n["out"]))
            rp += bool(G.remnant(c, py))
            mm += py != n["out"]
        self.assertLessEqual(rn, MAX_REMNANT_NODE, "more node remnants than recorded")
        self.assertLessEqual(rp, MAX_REMNANT_PYTHON, "more python remnants than recorded")
        self.assertLessEqual(mm, MAX_MISMATCH, "more node/python mismatches than recorded")
        print("fuzz slice: cases=%d remnant_node=%d remnant_python=%d mismatch=%d" % (len(cases), rn, rp, mm))


class WrappedKeyEdges(unittest.TestCase):
    """Same cases as the last tests of packages/zn-gate/test/scrub_fuzz_corpus.test.js."""

    def test_lower_case_last_line_of_a_wrapped_key_is_redacted(self):
        out = redact_secrets("token sk-proj-FAKEABCDEFGHJKLMNPQRSTUVWXYZABCDEFGHJK\nqwertyuiop.")[0]
        self.assertNotIn("qwertyuiop", out)
        self.assertNotIn("FAKEABCD", out)

    def test_lower_case_last_line_is_kept_with_a_key_not_complete_without_it(self):
        out = redact_secrets("token ghp_FAKE0123456789ABCDEFabcdef0123\nqwertyuiop-x done")[0]
        self.assertNotIn("qwertyuiop", out)
        self.assertNotIn("FAKE0123", out)

    def test_sk_run_in_a_jwt_signature_never_stays_readable(self):
        # An sk- key in the last part of a JWT-shaped token loses its whole body (header and payload lengths 8 to 12,
        # bodies with dashes and underscores).
        import random
        rnd = random.Random("jwt-sk-signature")
        alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        body_chars = alnum + "_-"
        for i in range(300):
            head = "eyJ" + "".join(rnd.choice(alnum) for _ in range(rnd.randint(8, 12)))
            pay = "eyJ" + "".join(rnd.choice(alnum) for _ in range(rnd.randint(8, 12)))
            prefix = rnd.choice(["sk-", "sk-proj-", "sk-svcacct-", "sk-admin-"])
            body = "FAKE" + "".join(rnd.choice(body_chars) for _ in range(rnd.randint(36, 60))) + rnd.choice(alnum)
            text = rnd.choice(["token ", "`", "x=", ""]) + head + "." + pay + "." + prefix + body + rnd.choice(["", " ok", "`"])
            with self.subTest(i=i):
                out = redact_secrets(text)[0]
                for k in range(0, len(body) - 8):
                    self.assertNotIn(body[k:k + 8], out, text)

    def test_key_after_a_dot_is_redacted(self):
        out = redact_secrets("cfg.sk-test-FAKE0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8")[0]
        self.assertEqual("cfg.[REDACTED_OPENAI_KEY]", out)


if __name__ == "__main__":
    unittest.main()
