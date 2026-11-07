"""zn-gate check: proves the Python guard works without Node.js."""
import io
import socket
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from zn_gate import cli

FAKE = "AKIA" + "ZNTESTFAKE" + "000000"


def run_check():
    out, err = io.StringIO(), io.StringIO()
    with mock.patch("sys.argv", ["zn-gate", "check"]), redirect_stdout(out), redirect_stderr(err):
        code = cli.main()
    return code, out.getvalue() + err.getvalue()


class TestCheckCommand(unittest.TestCase):
    def test_pass_case(self):
        code, text = run_check()
        self.assertEqual(code, 0, text)
        self.assertTrue(any(l.startswith("OK:") for l in text.splitlines()), text)
        self.assertIn("npx -y zn-gate check", text)
        self.assertIn("REDACTED", text)

    def test_output_never_has_the_full_fake_secret(self):
        _, text = run_check()
        self.assertNotIn(FAKE, text)

    def test_forced_failure_when_guard_lets_the_secret_through(self):
        def leaky():
            def read_file(path):
                with open(path, encoding="utf-8") as handle:
                    return handle.read()
            return read_file

        with mock.patch.object(cli, "_guarded_reader", leaky):
            code, text = run_check()
        self.assertEqual(code, 1, text)
        self.assertIn("FAIL", text)
        self.assertIn("let it through", text)
        self.assertIn("NOT OK", text)
        self.assertFalse(any(l.startswith("OK:") for l in text.splitlines()))
        self.assertNotIn(FAKE, text)

    def test_forced_failure_when_guard_blocks_benign_text(self):
        from zn_gate.guard import GuardBlockError
        from zn_gate.rules import Assessment

        def strict():
            def read_file(path):
                raise GuardBlockError(Assessment(verdict="block", confidence=1.0, rule="test:forced", reason="forced"), "read_file")
            return read_file

        with mock.patch.object(cli, "_guarded_reader", strict):
            code, text = run_check()
        self.assertEqual(code, 1, text)
        self.assertIn("benign text: blocked by mistake", text)

    def test_pass_path_names_the_detector_that_caught_the_secret(self):
        code, text = run_check()
        self.assertEqual(code, 0, text)
        line = next(l for l in text.splitlines() if "fake secret" in l)
        self.assertIn("rule: secret:aws_access_key", line)
        self.assertNotIn(FAKE, text)

    def test_fails_and_names_the_rule_when_the_guard_does_not_block(self):
        def leaky():
            def read_file(path):
                with open(path, encoding="utf-8") as handle:
                    return handle.read()
            return read_file

        with mock.patch.object(cli, "_guarded_reader", leaky):
            code, text = run_check()
        self.assertNotEqual(code, 0, text)
        line = next(l for l in text.splitlines() if "let it through" in l)
        self.assertIn("secret:aws_access_key", line)
        self.assertNotIn(FAKE, text)

    def test_no_network(self):
        def no_net(*a, **k):
            raise AssertionError("network used")

        with mock.patch.object(socket, "socket", no_net), mock.patch.object(socket, "create_connection", no_net), \
                mock.patch.object(socket, "getaddrinfo", no_net):
            code, text = run_check()
        self.assertEqual(code, 0, text)

    def test_writes_only_inside_a_temp_folder(self):
        import os
        import tempfile
        before = set(os.listdir(tempfile.gettempdir()))
        run_check()
        self.assertEqual(set(os.listdir(tempfile.gettempdir())) - before, set())

    def test_check_is_not_an_npm_only_command(self):
        self.assertNotIn("check", cli.NPM_ONLY_COMMANDS)
        self.assertIn("check", cli.known_commands(cli.build_parser()))

    def test_help_points_to_npm_for_agent_hooks(self):
        sub = cli.build_parser().get_default("_subparsers").choices["check"]
        text = " ".join(sub.format_help().split())
        self.assertIn("Python guard only", text)
        self.assertIn("npx -y zn-gate check", text)


if __name__ == "__main__":
    unittest.main()
