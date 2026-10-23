import unittest

import importlib

guard_module = importlib.import_module("zn_gate.guard")
from zn_gate.integrations import langchain as lc

KEY = "AKIAIOSFODNN7EXAMPLE"


class StrSub(str):
    pass


class OddStr(Exception):
    def __str__(self):
        return StrSub("odd")


class BrokenStr(Exception):
    def __str__(self):
        raise RuntimeError("no str")


class TestErrorTextsSingleImplementation(unittest.TestCase):
    def test_both_modules_share_the_same_function_objects(self):
        for name in ("_error_texts", "_safe_text", "_mask_text"):
            self.assertIs(getattr(lc, name), getattr(guard_module, name), name)

    def test_safe_text_returns_a_plain_str(self):
        # Difference 1: the LangChain copy wrapped the result in str().
        out = guard_module._safe_text(str, OddStr())
        self.assertEqual(out, "odd")
        self.assertIs(type(out), str)

    def test_safe_text_swallows_failures(self):
        self.assertEqual(guard_module._safe_text(str, BrokenStr()), "")

    def test_mask_text_masks_secrets_and_keeps_clean_text(self):
        self.assertNotIn(KEY, guard_module._mask_text(f"key={KEY}"))
        self.assertEqual(guard_module._mask_text("hello"), "hello")

    def test_error_texts_follows_the_chain_once_and_stops_at_the_limit(self):
        a = ValueError("a")
        b = KeyError("b")
        a.__cause__ = b
        b.__context__ = a  # cycle
        self.assertEqual(len(guard_module._error_texts(a)), 4)
        e = ValueError("0")
        cur = e
        for i in range(1, 20):
            nxt = ValueError(str(i))
            cur.__cause__ = nxt
            cur = nxt
        self.assertEqual(len(guard_module._error_texts(e)), 16)


if __name__ == "__main__":
    unittest.main()
