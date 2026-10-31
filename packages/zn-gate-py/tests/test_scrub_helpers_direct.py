"""Direct tests of two scrubber helpers in rules.py: the body check of the OpenAI key rule and the
context check of the AWS secret key rule. Fake values only."""

import unittest

from zn_gate import rules as R

KEY = "Zr8Qm2Xc7Vb4Nk9Lp3Ws6Td1Yh5Gf0JaB+/Eu2Ox"  # 40 characters, made up
BODY = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hI7"


class OpenaiScrubBodyTests(unittest.TestCase):
    def test_random_body_with_a_digit_passes_with_or_without_a_prefix(self):
        for prefix in ("sk-", "sk-proj-", "sk-svcacct-"):
            self.assertTrue(R._openai_scrub_body(prefix + BODY), prefix)

    def test_one_character_class_fails(self):
        self.assertFalse(R._openai_scrub_body("sk-" + "a" * 40))
        self.assertFalse(R._openai_scrub_body("sk-" + "1" * 40))

    def test_letters_only_body_fails_for_lack_of_a_digit(self):
        self.assertFalse(R._openai_scrub_body("sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"))

    def test_empty_and_prefix_only_fail(self):
        self.assertFalse(R._openai_scrub_body(""))
        self.assertFalse(R._openai_scrub_body("sk-"))


class AwsSecretContextTests(unittest.TestCase):
    def check(self, text):
        start = text.index(KEY) if KEY in text else 0
        return R._aws_secret_context(text, start, start + 40)

    def test_aws_and_secret_words_before_a_random_value_pass(self):
        self.assertTrue(self.check("aws secret access key = " + KEY))
        self.assertTrue(self.check("SecretAccessKey " + KEY))

    def test_only_one_of_the_two_words_fails(self):
        self.assertFalse(self.check("secret: " + KEY))
        self.assertFalse(self.check("aws: " + KEY))
        self.assertFalse(self.check("password " + KEY))

    def test_no_context_at_all_fails(self):
        self.assertFalse(self.check(KEY))

    def test_words_further_than_160_characters_back_do_not_count(self):
        self.assertFalse(self.check("secret aws " + "x" * 200 + KEY))

    def test_value_that_does_not_look_random_fails(self):
        text = "aws secret " + "a" * 40
        self.assertFalse(R._aws_secret_context(text, 11, 51))

    def test_empty_text_fails(self):
        self.assertFalse(R._aws_secret_context("", 0, 0))


if __name__ == "__main__":
    unittest.main()
