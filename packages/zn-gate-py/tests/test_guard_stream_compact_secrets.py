"""Compact text full of secrets, with no white space to cut at, streamed in chunks of
many sizes, comes out masked as the whole text is. Fictitious values only.
"""

import hashlib
import json
import unittest

from zn_gate import guard
from zn_gate.guard import _mask_text


def run(chunks):
    @guard(mask_secrets=True, check_args=False)
    def tool():
        yield from chunks

    return list(tool())


def chunked(text, size):
    return [text[i:i + size] for i in range(0, len(text), size)]


def compact_credentials(n=6000):
    # A compact JSON list: no white space anywhere, a cut between a key and its value
    # would leave the value unmasked.
    rows = [{"id": i, "api_key": "q7" + hashlib.sha256(b"%d" % i).hexdigest()[:30]} for i in range(n)]
    return json.dumps(rows, separators=(",", ":"))


def dense_keys(n=20000):
    # Secrets back to back, only a comma between them.
    return ",".join("AKIA%016d" % i for i in range(n))


SIZES = (16 * 1024, 64 * 1024, 128 * 1024, 300 * 1024)


class TestCompactSecretsStream(unittest.TestCase):
    def check(self, text):
        whole = _mask_text(text)
        self.assertNotEqual(whole, text)
        for size in SIZES:
            for as_bytes in (False, True):
                with self.subTest(size=size, as_bytes=as_bytes):
                    pieces = chunked(text.encode("utf-8") if as_bytes else text, size)
                    out = run(pieces)
                    joined = b"".join(out).decode("utf-8") if as_bytes else "".join(out)
                    self.assertTrue(joined == whole, "differs from the whole text masked at %d" % next(
                        (i for i, (a, b) in enumerate(zip(joined, whole, strict=False)) if a != b), min(len(joined), len(whole))))

    def test_compact_json_credentials(self):
        text = compact_credentials()
        self.assertGreater(len(text), 300 * 1024)
        self.check(text)
        out = "".join(run(chunked(text, 128 * 1024)))
        self.assertFalse('"api_key":"q7' in out, "a credential value came out unmasked")

    def test_dense_keys_separated_by_commas(self):
        text = dense_keys()
        self.check(text)
        self.assertFalse("AKIA0000" in "".join(run(chunked(text, 16 * 1024))), "a key came out unmasked")


if __name__ == "__main__":
    unittest.main()
