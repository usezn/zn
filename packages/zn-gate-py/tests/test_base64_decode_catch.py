"""Only an undecodable Base64 payload is skipped; an error from evaluate() on the decoded text is not swallowed
(same cases as packages/zn-gate/test/rules_base64_decode_catch.test.js)."""
import base64
import binascii
import unittest
from unittest import mock

from zn_gate import rules as R

PIPE = "echo " + base64.b64encode(b"echo hello world").decode() + " | base64 -d | sh"


class TestBase64DecodeCatch(unittest.TestCase):
    def test_error_in_evaluate_is_not_swallowed(self):
        with mock.patch.object(R, "evaluate", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                R._check_base64_pipes((PIPE,), False)

    def test_error_in_evaluate_never_gives_allow_through_the_public_call(self):
        real = R.evaluate

        def flaky(text, *a, **k):
            if text == PIPE:
                return real(text, *a, **k)
            raise RuntimeError("boom")

        with mock.patch.object(R, "evaluate", side_effect=flaky):
            with self.assertRaises(RuntimeError):
                R.evaluate(PIPE)

    def test_invalid_base64_is_still_ignored(self):
        for exc in (binascii.Error("bad"), ValueError("bad"), UnicodeDecodeError("utf-8", b"", 0, 1, "bad")):
            with self.subTest(exc=type(exc).__name__):
                with mock.patch.object(R, "_b64_decode_lenient", side_effect=exc):
                    with mock.patch.object(R, "evaluate", side_effect=RuntimeError("must not run")) as ev:
                        block, _ = R._check_base64_pipes((PIPE,), False)
                self.assertIsNone(block)
                ev.assert_not_called()

    def test_real_invalid_base64_does_not_raise(self):
        res = R.evaluate("echo QUJD=REVG | base64 -d | sh")
        self.assertIn(res.verdict, ("allow", "block"))


if __name__ == "__main__":
    unittest.main()
