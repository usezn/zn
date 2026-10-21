"""Secret redaction must give the same text in Python and in Node.js.

Seeded random texts are built from fake secret values, NAME= and NAME: starts, separators and
line breaks, and redacted by both engines: Python here, Node.js through
packages/zn-gate/test/helpers/export_redaction.js. These tests need the monorepo checkout and a
`node` binary; they are skipped with a message when either is missing (for example when testing
an sdist).
"""

import json
import random
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate.rules import redact_secrets

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
EXPORT_SCRIPT = NODE_PKG / "test" / "helpers" / "export_redaction.js"

# Fake values only, built in pieces so that no full key appears in the source.
STRIPE = "sk_" + "live_" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1w"
AWS_ID = "AKIA" + "IOSFODNN7EXAMPLE"
GITHUB = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
VALUE = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c"
TAIL = "Xy4zAb7cDe0f"

PIECES = [
    "abcdefghij", "KLMNOPQRST", "0123456789", "ab_+/=-cd", "ABCDE", "x", ".", "=", " ", "\t", "\r", "\n", "\n",
    "NAME=", "key: ", "token:", "AWS_SECRET_ACCESS_KEY=", "export DB_PASSWORD=", "API_KEY=",
    STRIPE, AWS_ID, GITHUB, GITHUB[:20], GITHUB[20:], VALUE, VALUE[:20], VALUE[20:], TAIL,
]

# Texts on which the two engines disagreed before they were aligned.
REGRESSIONS = [
    "ABCDE=" + STRIPE + "x\n",
    "AWS_SECRET_ACCESS_KEY=NAME=" + STRIPE + " x0123456789",
    "AWS_SECRET_ACCESS_KEY=\r" + TAIL + "\n" + STRIPE + "\r",
    "AWS_SECRET_ACCESS_KEY=" + STRIPE + "AWS_SECRET_ACCESS_KEY=\n" + STRIPE + "ABCDE .",
    "key: " + STRIPE + "NAME=\n",
    "." + STRIPE + "=ab",
]


def random_texts(count, seed):
    rnd = random.Random(seed)
    return ["".join(rnd.choice(PIECES) for _ in range(rnd.randint(1, 30))) for _ in range(count)]


def node_redact(texts):
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed: skipping the Node.js/Python redaction parity check")
    if not EXPORT_SCRIPT.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the redaction parity check")
    with tempfile.TemporaryDirectory() as tmp:
        cases = Path(tmp) / "cases.json"
        cases.write_text(json.dumps(texts), encoding="utf8")
        out = subprocess.run([node, str(EXPORT_SCRIPT), str(cases)], cwd=tmp, check=True,
                             capture_output=True, timeout=120).stdout
    return json.loads(out.decode("utf8"))


class RedactionParityFuzzTest(unittest.TestCase):
    def test_same_redaction_as_node(self):
        texts = REGRESSIONS + random_texts(2000, seed=20261021)
        js = node_redact(texts)
        py = [redact_secrets(t)[0] for t in texts]
        diff = [(t, j, p) for t, j, p in zip(texts, js, py) if j != p]
        detail = "\n".join("text %r\n  node   %r\n  python %r" % d for d in diff[:5])
        self.assertEqual(len(diff), 0, "%d of %d texts differ:\n%s" % (len(diff), len(texts), detail))


if __name__ == "__main__":
    unittest.main()
