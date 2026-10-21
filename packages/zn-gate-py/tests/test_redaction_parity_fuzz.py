"""Secret redaction must give the same text in Python and in Node.js, and neither may leave a key visible.

Seeded random texts are built from fake secret values, NAME= and NAME: starts, separators, suffixes and
line breaks, and redacted by both engines: Python here, Node.js through
packages/zn-gate/test/helpers/export_redaction.js. Parity alone would not catch a gap both engines share,
so the tests also check that no fake key stays in the output of either engine. These tests need the
monorepo checkout and a `node` binary; they are skipped with a message when either is missing (for
example when testing an sdist).
"""

import json
import random
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate.rules import redact_secrets

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
EXPORT_SCRIPT = NODE_PKG / "test" / "helpers" / "export_redaction.js"

# Fake values only, built in pieces so that no full key appears in the source. Each key maps to the
# part that must never be left in the output.
STRIPE = "sk_" + "live_" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1w"
AWS_ID = "AKIA" + "IOSFODNN7EXAMPLE"
GITHUB = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
SLACK = "xox" + "b-123456789012-1234567890123-Ab3dEf6hIj9kLm2nOp5qRs8t"
GOOGLE = "AIza" + "SyAb3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zA"
KEYS = {
    STRIPE: STRIPE[8:],
    AWS_ID: AWS_ID[4:],
    GITHUB: GITHUB[4:],
    SLACK: SLACK[-24:],
    GOOGLE: GOOGLE[4:],
}
VALUE = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c"
TAIL = "Xy4zAb7cDe0f"

PIECES = [
    "abcdefghij", "KLMNOPQRST", "0123456789", "ab_+/=-cd", "ABCDE", "x", ".", "=", " ", "\t", "\r", "\n", "\n",
    "NAME=", "key: ", "token:", "AWS_SECRET_ACCESS_KEY=", "export DB_PASSWORD=", "API_KEY=", "_abc", "-old",
    STRIPE, AWS_ID, GITHUB, GITHUB[:20], GITHUB[20:], VALUE, VALUE[:20], VALUE[20:], TAIL,
]

# Texts on which the two engines disagreed, or both left a key visible, before they were fixed.
REGRESSIONS = [
    "ABCDE=" + STRIPE + "x\n",
    "AWS_SECRET_ACCESS_KEY=NAME=" + STRIPE + " x0123456789",
    "AWS_SECRET_ACCESS_KEY=\r" + TAIL + "\n" + STRIPE + "\r",
    "AWS_SECRET_ACCESS_KEY=" + STRIPE + "AWS_SECRET_ACCESS_KEY=\n" + STRIPE + "ABCDE .",
    "key: " + STRIPE + "NAME=\n",
    "." + STRIPE + "=ab",
    STRIPE + "_abc",
    STRIPE + "-old",
    "key=" + STRIPE + "_abc",
    "AWS_SECRET_ACCESS_KEY=" + VALUE[:20] + "\n" + STRIPE + "_abc",
]

# A key with a separator (or nothing) on each side, or followed by a suffix that starts with _ or -.
# Letters or digits glued to a fixed-length key make a different, longer token, so they are not here.
CONTEXTS = ["{k}", "{k}_abc", "{k}-old", "key={k}_abc", "x {k}_abc y", '"{k}_abc"', "X={k}_test_value", "{k}.",
            "AWS_SECRET_ACCESS_KEY=" + VALUE[:20] + "\n{k}_abc"]

TOKEN = re.compile(r"[A-Za-z0-9_-]")


def random_texts(count, seed):
    rnd = random.Random(seed)
    return ["".join(rnd.choice(PIECES) for _ in range(rnd.randint(1, 30))) for _ in range(count)]


def exposed_count(text, key):
    """How many times `key` appears in `text` as a key: no token character right before it, and after
    it the end, a non-token character, or a suffix starting with _ or -."""
    count = 0
    start = text.find(key)
    while start != -1:
        end = start + len(key)
        before_ok = start == 0 or not TOKEN.match(text[start - 1])
        after_ok = end == len(text) or not TOKEN.match(text[end]) or text[end] in "_-"
        if before_ok and after_ok:
            count += 1
        start = text.find(key, end)
    return count


def leaked(text, out):
    """Keys of KEYS that are still visible in `out`. The secret part of a key can also be in the text
    in other places (glued to other letters, or inside a longer value), so a key counts as left when
    `out` has more copies of its secret part than those other places account for."""
    left = []
    for key, secret in KEYS.items():
        exposed = exposed_count(text, key)
        if exposed and out.count(secret) > text.count(secret) - exposed:
            left.append(key)
    return left


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
        diff = [(t, j, p) for t, j, p in zip(texts, js, py, strict=True) if j != p]
        detail = "\n".join("text %r\n  node   %r\n  python %r" % d for d in diff[:5])
        self.assertEqual(len(diff), 0, "%d of %d texts differ:\n%s" % (len(diff), len(texts), detail))

    def test_no_key_left_visible(self):
        curated = [c.format(k=k) for k in KEYS for c in CONTEXTS]
        texts = REGRESSIONS + curated + random_texts(2000, seed=20261022)
        js = node_redact(texts)
        leaks = []
        for t, j in zip(texts, js, strict=True):
            p = redact_secrets(t)[0]
            for engine, out in (("node", j), ("python", p)):
                if leaked(t, out):
                    leaks.append((engine, t, out))
        detail = "\n".join("%s left a key in %r\n  -> %r" % d for d in leaks[:5])
        self.assertEqual(len(leaks), 0, "%d leaks:\n%s" % (len(leaks), detail))


if __name__ == "__main__":
    unittest.main()
