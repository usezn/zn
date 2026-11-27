"""Benign near-misses for the rules added or changed in 1.19, in the Python package.

The command lines are packages/zn-gate/test/fixtures/benign_near_miss_commands.json (the Node test reads the same file) and the
sentences are packages/zn-gate/test/fixtures/benign_phrases.json (the false-positive gate of the Node rules reads it too).
Fictional paths and hosts; the strings are only analysed, never run.
"""

import json
import unittest
from pathlib import Path

from zn_gate import check_command, evaluate

FIXTURES = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures"
COMMANDS = json.loads(FIXTURES.joinpath("benign_near_miss_commands.json").read_text(encoding="utf-8"))["commands"]
PHRASES = json.loads(FIXTURES.joinpath("benign_phrases.json").read_text(encoding="utf-8"))["phrases"]


class BenignNearMiss(unittest.TestCase):
    def test_commands_close_to_a_rule_stay_allowed(self):
        self.assertGreaterEqual(len(COMMANDS), 30)
        self.assertEqual(len(set(COMMANDS)), len(COMMANDS))
        blocked = [(c, str(check_command(c).rule)) for c in COMMANDS if not check_command(c).allowed]
        self.assertEqual(blocked, [])

    def test_empty_command_is_a_string(self):
        self.assertTrue(check_command("").allowed)
        self.assertTrue(check_command("   ").allowed)

    def test_three_levels_of_shell_nesting_stay_allowed(self):
        self.assertTrue(check_command("sh -c \"sh -c \\\"sh -c 'echo hi'\\\"\"").allowed)

    def test_phrases_are_not_blocked(self):
        blocked = [(p, evaluate(p).rule) for p in PHRASES if evaluate(p).verdict == "block"]
        self.assertEqual(blocked, [])


if __name__ == "__main__":
    unittest.main()
