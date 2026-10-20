"""Secrets printed across several lines (wrapped every 10 or 20 characters) are
redacted whole, and short words or NAME= lines after them are left alone (see
test/scrub_wrapped_secrets.test.js)."""
import unittest

from zn_gate import rules as R

# Fictitious GitHub token: "ghp_" + 36 characters.
KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'


def wrap(s: str, n: int) -> str:
    return '\n'.join(s[i:i + n] for i in range(0, len(s), n))


class WrappedSecrets(unittest.TestCase):
    def redact(self, text: str) -> str:
        return R.redact_secrets(text)[0]

    def test_wrapped_every_20_and_10(self):
        for n in (20, 10):
            out = self.redact('token:\n' + wrap(KEY, n) + '\n')
            self.assertRegex(out, r'\[REDACTED_GITHUB_TOKEN\]')
            for part in wrap(KEY, n).split('\n'):
                self.assertNotIn(part, out)

    def test_crlf_and_indentation(self):
        out = self.redact('  ' + KEY[:20] + '\r\n  ' + KEY[20:] + '\r\n')
        self.assertNotIn(KEY[20:], out)

    def test_short_word_on_next_line_is_kept(self):
        out = self.redact('token:\n' + wrap(KEY, 20) + '\nend')
        self.assertTrue(out.endswith('\nend'), out)

    def test_name_line_not_joined(self):
        text = 'ALPHA_VALUE=abcdefghijklmnop\nNEXT_SETTING_NAME=abcdefghij'
        self.assertEqual(self.redact(text), text)

    def test_consecutive_secrets_each_redacted(self):
        other = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'
        out, found = R.redact_secrets(KEY + '\n' + other)
        self.assertNotIn(KEY[-12:], out)
        self.assertNotIn(other[-12:], out)
        self.assertEqual(len(found), 2)

    def test_ordinary_text_unchanged(self):
        text = 'The quick brown fox\njumps over the lazy dog\nand_snake_case_names\nkeep_their_lines'
        self.assertEqual(self.redact(text), text)

    def test_view_maps_wrap_break(self):
        text = 'abcdefghij\nklmnopqrst'
        clean, mapping = R.invisible_view(text)
        self.assertEqual(clean, 'abcdefghijklmnopqrst')
        self.assertEqual(mapping[10], 11)
        self.assertEqual(mapping[len(clean)], len(text))
        self.assertIsNone(R.invisible_view('short\nlines'))


if __name__ == '__main__':
    unittest.main()
