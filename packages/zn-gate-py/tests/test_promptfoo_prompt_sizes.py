"""promptfoo.call_api keeps the same result keys for unusual prompt sizes."""
import unittest

from zn_gate.integrations import promptfoo

TOP_KEYS = {"output", "tokenUsage", "cost", "cached", "metadata"}
META_KEYS = {"verdict", "rule", "reason", "confidence", "latency_ms", "allowed"}

PROMPTS = {
    "empty": "",
    "multi_line": "first line\nsecond line\r\nthird line\n\nlast line",
    "100_kib": "The weather is mild today. " * (100 * 1024 // 27 + 1),
}


class TestPromptfooPromptSizes(unittest.TestCase):
    def test_keys_are_the_same_for_each_prompt(self):
        for name, prompt in PROMPTS.items():
            with self.subTest(prompt=name):
                res = promptfoo.call_api(prompt)
                self.assertEqual(set(res), TOP_KEYS)
                self.assertEqual(set(res["metadata"]), META_KEYS)
                self.assertEqual(set(res["tokenUsage"]), {"total", "prompt", "completion"})
                self.assertIsInstance(res["output"], str)
                self.assertIsInstance(res["metadata"]["allowed"], bool)

    def test_prompt_is_at_least_100_kib(self):
        self.assertGreaterEqual(len(PROMPTS["100_kib"]), 100 * 1024)


if __name__ == "__main__":
    unittest.main()
