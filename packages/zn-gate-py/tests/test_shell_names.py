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

    def test_secret_follow_up_uses_npx_cmd_on_windows(self):
        from zn_gate.mcp_secrets import mcp_next_step
        with mock.patch("zn_gate.shell_names.os.name", "nt"):
            msg = mcp_next_step("environment variable", "API_KEY")
        self.assertIn("run npx.cmd -y zn-gate secret set ", msg)
        self.assertIn("run npx.cmd -y zn-gate secret allow ", msg)
        self.assertNotIn("run zn secret allow", msg)

    def test_secret_follow_up_is_unchanged_on_posix(self):
        from zn_gate.mcp_secrets import mcp_next_step
        with mock.patch("zn_gate.shell_names.os.name", "posix"):
            msg = mcp_next_step("environment variable", "API_KEY")
        self.assertIn("run npx -y zn-gate secret set ", msg)
        self.assertIn("run zn secret allow ", msg)
        self.assertNotIn("npx.cmd", msg)


if __name__ == "__main__":
    unittest.main()


def test_zn_gate_name_is_cmd_on_windows(monkeypatch):
    from zn_gate import shell_names
    monkeypatch.setattr(shell_names.os, "name", "nt")
    assert shell_names.zn_gate_name() == "zn-gate.cmd"
    monkeypatch.setattr(shell_names.os, "name", "posix")
    assert shell_names.zn_gate_name() == "zn-gate"


def test_npm_only_note_names_the_cmd_shim_on_windows(monkeypatch):
    from zn_gate import cli, shell_names
    monkeypatch.setattr(shell_names.os, "name", "nt")
    monkeypatch.setattr(cli, "node_available", lambda: True)
    msg = cli.npm_only_simple_message("connect")
    assert "  npx.cmd -y zn-gate connect" in msg
    assert "  zn-gate.cmd connect" in msg
