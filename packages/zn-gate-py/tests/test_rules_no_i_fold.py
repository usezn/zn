import unittest

from zn_gate import rules


class NoIFoldTests(unittest.TestCase):
    def test_each_letter_maps_to_one_private_use_character(self):
        for k, v in rules._NO_I_FOLD.items():
            self.assertEqual(len(v), 1, hex(k))
            self.assertTrue(0xE000 <= ord(v) <= 0xF8FF, hex(k))

    def test_translation_keeps_length(self):
        text = "İdınt İ ı"
        self.assertEqual(len(text.translate(rules._NO_I_FOLD)), len(text))


if __name__ == "__main__":
    unittest.main()
