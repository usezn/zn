"""The messages printed for commands that live only in the npm package."""
import re
import unittest

from zn_gate.cli import (
    NPM_ONLY_COMMANDS,
    NPM_ONLY_SIMPLE_COMMANDS,
    npm_only_message,
    npm_only_simple_message,
)

NAME = re.compile(r"^[a-z]+(-[a-z]+)*$")


class TestNpmOnlyMessage(unittest.TestCase):
    def test_message_for_every_command(self):
        for cmd in sorted(NPM_ONLY_COMMANDS):
            msg = npm_only_message(cmd)
            self.assertTrue(msg.startswith(f"zn-gate {cmd}"), msg)
            self.assertIn("is in the npm package", msg)
            self.assertIn("npx -y zn-gate init", msg)
            self.assertTrue(msg.endswith("\n"), repr(msg))


class TestNpmOnlySimpleMessage(unittest.TestCase):
    def test_message_for_every_command(self):
        for cmd in sorted(NPM_ONLY_SIMPLE_COMMANDS):
            msg = npm_only_simple_message(cmd)
            lines = msg.splitlines()
            self.assertIn(cmd, lines[0])
            self.assertIn(f"npx -y zn-gate {cmd}", msg)
            self.assertIn(f"  zn-gate {cmd}", lines)
            self.assertTrue(msg.endswith("\n"), repr(msg))


class TestCommandSets(unittest.TestCase):
    def test_sets_do_not_overlap(self):
        self.assertEqual(NPM_ONLY_COMMANDS & NPM_ONLY_SIMPLE_COMMANDS, frozenset())

    def test_names_are_lowercase_words(self):
        for cmd in NPM_ONLY_COMMANDS | NPM_ONLY_SIMPLE_COMMANDS:
            self.assertRegex(cmd, NAME)


if __name__ == "__main__":
    unittest.main()
