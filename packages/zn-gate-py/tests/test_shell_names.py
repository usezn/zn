"""npx.cmd on Windows, npx elsewhere, in the messages that tell a person what to type."""
import unittest
from unittest import mock

from zn_gate.cli import npm_only_message
from zn_gate.shell_names import npx_name


class TestNpxName(unittest.TestCase):
    def test_windows_uses_the_cmd_shim(self):
        with mock.patch("zn_gate.shell_names.os.name", "nt"):
            self.assertEqual(npx_name(), "npx.cmd")

    def test_posix_is_unchanged(self):
        with mock.patch("zn_gate.shell_names.os.name", "posix"):
            self.assertEqual(npx_name(), "npx")

    def test_init_message_names_the_cmd_form_on_windows(self):
        with mock.patch("zn_gate.shell_names.os.name", "nt"):
            msg = npm_only_message("init")
        self.assertIn("  npx.cmd -y zn-gate init\n", msg)

    def test_init_message_is_unchanged_on_posix(self):
        with mock.patch("zn_gate.shell_names.os.name", "posix"):
            msg = npm_only_message("init")
        self.assertIn("  npx -y zn-gate init\n", msg)
        self.assertNotIn("npx.cmd", msg)


if __name__ == "__main__":
    unittest.main()
