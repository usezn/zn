"""The text the rules match is the same in Node.js and Python when a line break sits next to U+0085."""

import unittest

from zn_gate import rules as R


class TestNormalizeU0085(unittest.TestCase):
    def test_word_split_by_u0085_and_line_break_is_rejoined(self):
        self.assertEqual(R.normalize_input("sys\u0085\ntem")[1], "system")
        self.assertEqual(R.normalize_input("sys\n\u0085tem")[1], "system")
        self.assertEqual(R.normalize_input("sys\u001c\n\u001ftem")[1], "system")

    def test_u0085_alone_does_not_rejoin_and_spaces_stay(self):
        self.assertEqual(R.normalize_input("sys\u0085tem")[1], "sys\u0085tem")
        self.assertEqual(R.normalize_input("go \u0085 now")[1], "go \u0085 now")


if __name__ == "__main__":
    unittest.main()
