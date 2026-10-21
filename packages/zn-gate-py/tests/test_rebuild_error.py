"""The guard tool wrapper and the LangChain integration rebuild a tool's exception
with the same helper. Runs without langchain-core: the integration module imports
without it, and only its handler needs the package.
"""
import unittest

from zn_gate.guard import MaskedToolError, guard
from zn_gate.guard import _rebuild_error as guard_rebuild_error
from zn_gate.integrations import langchain as langchain_module

KEY = "AKIAIOSFODNN7EXAMPLE"
DB_ERROR = f"connection failed for https://example.com/db?key={KEY}"


class DetailError(Exception):
    def __init__(self, message, detail):
        super().__init__(message)
        self.detail = detail

    def __str__(self):
        return f"{self.args[0]} ({self.detail})"


class TestRebuildErrorShared(unittest.TestCase):
    def test_langchain_uses_the_guard_implementation(self):
        self.assertIs(langchain_module._rebuild_error, guard_rebuild_error)

    def test_guard_wrapper_rebuilds_the_same_type(self):
        @guard(mask_secrets=True)
        def tool(q):
            raise ValueError(DB_ERROR)

        with self.assertRaises(ValueError) as cm:
            tool("weather")
        self.assertIs(type(cm.exception), ValueError)
        self.assertNotIn(KEY, str(cm.exception))
        self.assertIn("connection failed", str(cm.exception))

    def test_langchain_path_rebuilds_the_same_type(self):
        error = ValueError(DB_ERROR)
        masked = langchain_module._mask_text(str(error))
        rebuilt = langchain_module._rebuild_error(error, masked)
        self.assertIs(type(rebuilt), ValueError)
        self.assertNotIn(KEY, str(rebuilt))
        self.assertNotIn(KEY, repr(rebuilt))

    def test_type_that_cannot_be_rebuilt_falls_back_in_both_paths(self):
        message = "db failed"
        detail_message = f"{message} ({KEY})"

        @guard(mask_secrets=True)
        def tool(q):
            raise DetailError(message, KEY)

        with self.assertRaises(MaskedToolError) as cm:
            tool("weather")
        self.assertNotIn(KEY, str(cm.exception))

        masked = langchain_module._mask_text(detail_message)
        rebuilt = langchain_module._rebuild_error(DetailError(message, KEY), masked)
        self.assertIs(type(rebuilt), MaskedToolError)
        self.assertIsInstance(rebuilt, RuntimeError)
        self.assertNotIn(KEY, str(rebuilt))
        self.assertEqual(type(cm.exception), type(rebuilt))


if __name__ == "__main__":
    unittest.main()
