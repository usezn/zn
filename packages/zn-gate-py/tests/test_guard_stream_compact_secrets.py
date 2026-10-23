"""Compact text full of secrets, with no white space to cut at, streamed in chunks of
many sizes, comes out masked as the whole text is. Fictitious values only.
"""

import base64
import hashlib
import json
import unittest

from zn_gate import GuardBlockError, guard
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



def run_until_block(chunks):
    """What the guarded stream gives out before it ends or blocks, and whether it blocked."""
    @guard(mask_secrets=True, check_args=False)
    def tool():
        yield from chunks

    out = []
    try:
        for piece in tool():
            out.append(piece)
    except GuardBlockError as exc:
        return "".join(out), exc.assessment.rule
    return "".join(out), None


def b64(n, seed):
    raw = b""
    i = 0
    while len(raw) < n:
        raw += hashlib.sha512(b"%d-%d" % (seed, i)).digest()
        i += 1
    return base64.b64encode(raw)[:n].decode()


def fake_pem(seed, n):
    body = b64(n, seed)
    lines = "\n".join(body[i:i + 64] for i in range(0, n, 64))
    return "-----BEGIN RSA PRIVATE KEY-----\n" + lines + "\n-----END RSA PRIVATE KEY-----"


class TestLongSecretsStream(unittest.TestCase):
    def test_private_keys_in_small_chunks(self):
        # Each key has more places to cut than the nearest tries: the cut moves back far enough.
        text = "".join(fake_pem(i, 3300) + "," for i in range(120))
        whole = _mask_text(text)
        out, rule = run_until_block(chunked(text, 4096))
        self.assertIsNone(rule)
        self.assertTrue(out == whole, "differs from the whole text masked")
        self.assertNotIn("BEGIN RSA PRIVATE KEY", out)

    def test_long_private_keys_in_small_chunks(self):
        # The key rule only matches once the END line arrives: the open key is held until then.
        for n in (24000, 60000):
            key = fake_pem(n, n)
            for name, text in (("text", "log line\n" * 100 + key + "\nafter\n"),
                               ("json", json.dumps({"out": "log\n" * 100 + key + "\nafter"}))):
                with self.subTest(n=n, form=name):
                    whole = _mask_text(text)
                    self.assertNotIn("BEGIN RSA PRIVATE KEY", whole)
                    out, rule = run_until_block(chunked(text, 4096))
                    self.assertIsNone(rule)
                    self.assertTrue(out == whole, "differs from the whole text masked")

    def test_chunk_that_ends_inside_the_end_line(self):
        # A key is closed only by its whole END line, not by its first characters. These sizes and
        # paddings let the BEGIN line out with a check that stopped at "-----END ".
        for n, pad in ((17000, 3500), (20000, 500), (20000, 1500), (20000, 2500)):
            key = fake_pem(n, n)
            text = "x" * pad + "\n" + key + "\nafter\n"
            whole = _mask_text(text)
            end_at = text.index("-----END ")
            for into in (9, 12, 20):
                cut = end_at + into
                with self.subTest(n=n, pad=pad, into=into):
                    chunks = chunked(text[:cut], 4096) + chunked(text[cut:], 4096)
                    out, rule = run_until_block(chunks)
                    self.assertIsNone(rule)
                    self.assertNotIn("BEGIN RSA PRIVATE KEY", out)
                    self.assertTrue(out == whole, "differs from the whole text masked")

    def test_private_key_longer_than_the_buffer_blocks(self):
        key = fake_pem(5, 300000)
        text = "start\n" + key + "\nend\n"
        out, rule = run_until_block(chunked(text, 4096))
        self.assertEqual(rule, "secret:unmaskable")
        self.assertNotIn("BEGIN RSA PRIVATE KEY", out)
        body = key.split("\n")[5]
        self.assertNotIn(body, out)

    def test_private_key_across_the_hold_in_one_chunk(self):
        pre = '{"k":"v"},' * 40000
        key = fake_pem(9, 6400)
        text = pre + key + "," + "x" * (16384 - (len(key) - 3200) - 1)
        out, rule = run_until_block([text])
        self.assertIsNone(rule)
        self.assertTrue(out == _mask_text(text), "differs from the whole text masked")
        self.assertNotIn("BEGIN RSA PRIVATE KEY", out)

    def test_url_list_keeps_every_value_masked(self):
        values = [b64(30, i).replace("+", "A").replace("/", "B") for i in range(6000)]
        text = "&".join("https://example.com/cb?api_key=%s&token=x" % v for v in values)
        # The masker reads the whole line as one api_key value (no white space ends it), longer
        # than the stream can hold: the stream blocks rather than pass any of it on.
        out, rule = run_until_block(chunked(text, 16384))
        self.assertFalse(any(v in out for v in values), "an api_key value came out unmasked")
        self.assertEqual(rule, "secret:unmaskable")

    def test_short_stream_with_a_long_value_is_masked_whole(self):
        # Under the limit the whole text is held and masked at the end.
        value = "".join(hashlib.sha256(b"%d" % i).hexdigest() for i in range(120000 // 64))
        text = "API_KEY=" + value
        out, rule = run_until_block(chunked(text, 16384))
        self.assertIsNone(rule)
        self.assertTrue(out == _mask_text(text), "differs from the whole text masked")
        self.assertNotIn(value[:24], out)

    def test_value_longer_than_the_buffer_blocks_and_never_leaks(self):
        value = "".join(hashlib.sha256(b"%d" % i).hexdigest() for i in range(360000 // 64))
        text = "API_KEY=" + value
        for size in (16 * 1024, 64 * 1024, 300 * 1024):
            with self.subTest(size=size):
                out, rule = run_until_block(chunked(text, size))
                self.assertEqual(rule, "secret:unmaskable")
                self.assertNotIn(value[:24], out)
                self.assertFalse(any(value[i:i + 24] in out for i in range(0, len(value) - 24, 4096)),
                                 "part of the value came out")


if __name__ == "__main__":
    unittest.main()
