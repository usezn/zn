"""A cyclic, too deep or too large result is blocked in a controlled way, never by RecursionError.

Fictitious values only.
"""

import asyncio
import importlib
import unittest

from zn_gate import GuardBlockError, guard, sanitize_tool_result
from zn_gate import rules
from zn_gate.rules import SANITIZE_MAX_DEPTH, SANITIZE_MAX_ITEMS, SanitizeLimitError

guard_module = importlib.import_module("zn_gate.guard")
KEY = "AKIA" + "IOSFODNN7EXAMPLE"


def cyclic_dict():
    d = {"name": "report"}
    d["self"] = d
    return d


def cyclic_list():
    items = ["a"]
    items.append(items)
    return items


def nested(levels, leaf):
    value = leaf
    for _ in range(levels):
        value = {"x": value}
    return value


def _rule_of(call):
    try:
        call()
    except GuardBlockError as exc:
        return exc.assessment.rule
    return None


class TestLimitsMatchTheWalker(unittest.TestCase):
    def test_limits_are_the_walkers(self):
        self.assertEqual(SANITIZE_MAX_DEPTH, guard_module._DEFAULT_MAX_DEPTH)
        self.assertEqual(SANITIZE_MAX_ITEMS, guard_module.MAX_OBJECT_VALUES)


class TestSanitizeToolResultLimits(unittest.TestCase):
    def test_cyclic_dict_and_list_raise_a_controlled_error(self):
        for value in (cyclic_dict(), cyclic_list()):
            with self.subTest(kind=type(value).__name__):
                with self.assertRaises(SanitizeLimitError) as ctx:
                    sanitize_tool_result(value)
                self.assertEqual(ctx.exception.rule, "size:nesting")

    def test_cycle_through_several_containers(self):
        a = {"k": []}
        b = [a, (1, 2)]
        a["k"].append(b)
        with self.assertRaises(SanitizeLimitError):
            sanitize_tool_result(a)

    def test_deep_nesting_raises_at_the_eleventh_level(self):
        clean, found = sanitize_tool_result(nested(SANITIZE_MAX_DEPTH, KEY))
        self.assertFalse(KEY in repr(clean))
        self.assertTrue(found)
        with self.assertRaises(SanitizeLimitError) as ctx:
            sanitize_tool_result(nested(SANITIZE_MAX_DEPTH + 1, "x"))
        self.assertEqual(ctx.exception.rule, "size:nesting")

    def test_very_deep_nesting_is_not_a_recursion_error(self):
        with self.assertRaises(SanitizeLimitError):
            sanitize_tool_result(nested(5000, "x"))

    def test_too_many_values_raise_size_items(self):
        for value in ([0] * (SANITIZE_MAX_ITEMS + 1), {i: 0 for i in range(SANITIZE_MAX_ITEMS // 2 + 1)}):
            with self.subTest(kind=type(value).__name__):
                with self.assertRaises(SanitizeLimitError) as ctx:
                    sanitize_tool_result(value)
                self.assertEqual(ctx.exception.rule, "size:items")

    def test_a_container_shared_twice_is_not_a_cycle(self):
        shared = [KEY]
        clean, found = sanitize_tool_result({"a": shared, "b": shared, "c": (shared, shared)})
        self.assertNotIn(KEY, repr(clean))
        self.assertTrue(found)

    def test_ordinary_data_is_unchanged(self):
        data = {"a": [1, "b", ("c",)], "d": {"e": {"f"}}, "g": frozenset(["h"])}
        clean, found = sanitize_tool_result(data)
        self.assertEqual(clean, data)
        self.assertFalse(found)


class TestGuardBlocksUnmaskableResults(unittest.TestCase):
    def test_cyclic_results_block_with_mask_secrets(self):
        for make in (cyclic_dict, cyclic_list):
            with self.subTest(kind=make.__name__):
                @guard(mask_secrets=True)
                def tool(make=make):
                    return make()

                self.assertEqual(_rule_of(tool), "size:nesting")

    def test_verified_repro_cyclic_result_with_and_without_a_secret(self):
        # repro_py.py of the review: a dict that holds itself, with and without a secret.
        secret = "api_key=" + "abcd1234efgh5678ijkl"

        def with_secret():
            d = {"a": secret}
            d["self"] = d
            return d

        def without_secret():
            d = {"a": "hello"}
            d["self"] = d
            return d

        for make in (with_secret, without_secret):
            with self.subTest(kind=make.__name__):
                self.assertEqual(_rule_of(guard(mask_secrets=True, check_args=False)(make)), "size:nesting")

    def test_cyclic_result_blocks_with_check_result_too(self):
        @guard(check_result=True, mask_secrets=True)
        def tool():
            return cyclic_dict()

        self.assertEqual(_rule_of(tool), "size:nesting")

    def test_on_block_return_gives_the_fallback(self):
        @guard(on_block="return", fallback="withheld", mask_secrets=True)
        def tool():
            return cyclic_dict()

        self.assertEqual(tool(), "withheld")

    def test_async_cyclic_result_blocks(self):
        @guard(mask_secrets=True)
        async def tool():
            return cyclic_dict()

        self.assertEqual(_rule_of(lambda: asyncio.run(tool())), "size:nesting")

    def test_deep_result_blocks_with_nesting_rule(self):
        @guard(mask_secrets=True)
        def tool(levels):
            return nested(levels, "ok")

        self.assertIsNone(_rule_of(lambda: tool(SANITIZE_MAX_DEPTH)))
        self.assertEqual(_rule_of(lambda: tool(SANITIZE_MAX_DEPTH + 1)), "size:nesting")
        self.assertEqual(_rule_of(lambda: tool(5000)), "size:nesting")

    def test_too_large_result_blocks_with_items_rule(self):
        @guard(mask_secrets=True)
        def tool():
            return [0] * (SANITIZE_MAX_ITEMS + 1)

        self.assertEqual(_rule_of(tool), "size:items")

    def test_a_secret_in_a_nested_result_is_still_masked(self):
        @guard(mask_secrets=True)
        def tool():
            return {"outer": [{"key": KEY}]}

        self.assertNotIn(KEY, repr(tool()))

    def test_cyclic_chunk_in_a_stream_blocks(self):
        @guard(mask_secrets=True)
        def tool():
            yield "first"
            yield cyclic_dict()

        stream = tool()
        self.assertEqual(next(stream), "first")
        with self.assertRaises(GuardBlockError) as ctx:
            next(stream)
        self.assertEqual(ctx.exception.assessment.rule, "size:nesting")

    def test_mask_value_reports_the_rule(self):
        masked, blocked = guard_module._mask_value(cyclic_dict())
        self.assertIsNotNone(blocked)
        self.assertEqual(blocked.rule, "size:nesting")
        self.assertEqual(blocked.verdict, "block")
        self.assertIs(rules.SanitizeLimitError, SanitizeLimitError)


if __name__ == "__main__":
    unittest.main()
