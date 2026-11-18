"""Fail-closed block for a tool result whose secret cannot be masked (rule secret:unmaskable).

The real masker hides a secret in every shape it can walk, so these tests make it fail on
containers (strings still go through the real masker) and check that the result is withheld
and never passed on with the secret in it. Fake secrets only.
"""
import importlib
import unittest
from unittest import mock

from zn_gate import GuardBlockError
from zn_gate.guard import guard

# Not "from zn_gate import guard": the package attribute `guard` is the decorator, not the module.
guard_mod = importlib.import_module("zn_gate.guard")
rules = importlib.import_module("zn_gate.rules")

FAKE_KEY = "AKIAIOSFODNN7EXAMPLE"
_REAL_SANITIZE = rules.sanitize_tool_result


def _masks_only_strings(data, *args, **kwargs):
    """A masker that hides secrets in plain strings but leaves containers as they are."""
    if isinstance(data, str):
        return _REAL_SANITIZE(data, *args, **kwargs)
    return data, []


def _nested(levels, leaf):
    value = leaf
    for _ in range(levels):
        value = [value]
    return value


class TestUnmaskableResult(unittest.TestCase):
    def test_real_masker_still_masks_a_shallow_secret(self):
        masked, block = guard_mod._mask_value(_nested(3, "key " + FAKE_KEY))
        self.assertIsNone(block)
        self.assertNotIn(FAKE_KEY, repr(masked))

    def test_secret_that_stays_after_masking_blocks(self):
        with mock.patch.object(rules, "sanitize_tool_result", _masks_only_strings):
            res = {"note": "key " + FAKE_KEY}
            out, block = guard_mod._mask_value(res)
        self.assertIsNotNone(block)
        self.assertEqual(block.verdict, "block")
        self.assertEqual(block.rule, "secret:unmaskable")
        self.assertIs(out, res)

    def test_secret_nested_over_50_levels_blocks(self):
        with mock.patch.object(rules, "sanitize_tool_result", _masks_only_strings):
            out, block = guard_mod._mask_value(_nested(60, "key " + FAKE_KEY))
        self.assertIsNotNone(block)
        self.assertEqual(block.rule, "secret:unmaskable")

    def test_nesting_over_the_masker_limit_blocks_with_its_own_rule(self):
        # The real masker stops at 10 levels with a controlled block, before the fallback runs.
        out, block = guard_mod._mask_value(_nested(60, "key " + FAKE_KEY))
        self.assertIsNotNone(block)
        self.assertEqual(block.rule, "size:nesting")

    def test_jsonlike_refuses_nesting_over_50_levels(self):
        with self.assertRaises(guard_mod._Unscannable) as ctx:
            guard_mod._jsonlike(_nested(60, "x"))
        self.assertEqual(ctx.exception.rule, "secret:unmaskable")
        self.assertEqual(guard_mod._jsonlike(_nested(5, "x")), _nested(5, "x"))

    def test_result_without_a_secret_passes_even_if_containers_are_not_masked(self):
        with mock.patch.object(rules, "sanitize_tool_result", _masks_only_strings):
            out, block = guard_mod._mask_value({"note": "nothing here"})
        self.assertIsNone(block)
        self.assertEqual(out, {"note": "nothing here"})

    def test_guard_withholds_the_result_and_names_the_next_step(self):
        @guard(check_result=False, mask_secrets=True)
        def run():
            return {"note": "key " + FAKE_KEY}

        with mock.patch.object(rules, "sanitize_tool_result", _masks_only_strings):
            with self.assertRaises(GuardBlockError) as ctx:
                run()
        msg = str(ctx.exception)
        self.assertEqual(ctx.exception.assessment.rule, "secret:unmaskable")
        self.assertIn("(rule: secret:unmaskable)", msg)
        self.assertIn("The output of this tool was withheld", msg)
        self.assertIn("Next step: check where the data came from", msg)
        self.assertNotIn(FAKE_KEY, msg)
        self.assertIsNone(ctx.exception.payload)

    def test_guard_with_on_block_return_gives_the_fallback_not_the_secret(self):
        @guard(check_result=False, mask_secrets=True, on_block="return", fallback="withheld")
        def run():
            return _nested(60, "key " + FAKE_KEY)

        with mock.patch.object(rules, "sanitize_tool_result", _masks_only_strings):
            self.assertEqual(run(), "withheld")


if __name__ == "__main__":
    unittest.main()
