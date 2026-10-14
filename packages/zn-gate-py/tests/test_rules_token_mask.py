"""mask_token_runs: defence in depth for snippets, CLI output and the ledger preview.
Test values are invented and built at runtime."""

import unittest

from zn_gate.rules import mask_token_runs

MIXED = "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4"  # 24 characters with letters and digits
UUID = "3f2c9a1e-7b4d-4e8a-9c1f-0a1b2c3d4e5f"
HEX64 = "0123456789abcdef" * 4


class TestMaskTokenRuns(unittest.TestCase):
    def test_long_mixed_run_is_masked(self):
        self.assertEqual(mask_token_runs("token " + MIXED + " end"), "token [REDACTED_TOKEN] end")

    def test_short_mixed_run_is_kept(self):
        short = MIXED[:23]
        self.assertEqual(mask_token_runs("value " + short), "value " + short)

    def test_letters_only_and_digits_only_runs_are_kept(self):
        letters = "abcdefghijklmnopqrstuvwxyzABC"
        digits = "1234567890123456789012345"
        self.assertEqual(mask_token_runs(letters), letters)
        self.assertEqual(mask_token_runs(digits), digits)

    def test_uuid_is_kept(self):
        text = "request " + UUID + " done"
        self.assertEqual(mask_token_runs(text), text)

    def test_uuid_with_a_suffix_is_masked(self):
        self.assertEqual(mask_token_runs(UUID + "x1"), "[REDACTED_TOKEN]")

    def test_full_length_hex_digest_is_masked(self):
        self.assertEqual(mask_token_runs("sha256 " + HEX64), "sha256 [REDACTED_TOKEN]")

    def test_redaction_placeholders_are_not_masked_again(self):
        text = "[REDACTED_AWS_KEY] and [REDACTED_BEARER_TOKEN] and [REDACTED_URL_PASSWORD]"
        self.assertEqual(mask_token_runs(text), text)

    def test_empty_and_none_are_returned_unchanged(self):
        self.assertEqual(mask_token_runs(""), "")
        self.assertIsNone(mask_token_runs(None))


if __name__ == "__main__":
    unittest.main()
