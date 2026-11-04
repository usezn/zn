"""Symbols follow the stream a line is written to. A line written to stderr gets the
emoji only when stderr itself is a terminal, even when stdout is one. The stderr
callers in zn_gate.cli pass sys.stderr to _lead()."""

import argparse
import io
import os
import unittest
from unittest import mock

from zn_gate.cli import ALERT, CHECK, SHIELD, _lead, cmd_evidence


class _Tty(io.StringIO):
    """A stand-in for a terminal stream."""

    def isatty(self):
        return True


class _Pipe(io.StringIO):
    """A stand-in for a stream that is piped or redirected to a file."""

    def isatty(self):
        return False


class _LegacyTty(_Tty):
    """A terminal whose code page cannot encode the emoji."""

    encoding = "cp1252"


def _env(**changes):
    """The current environment without NO_COLOR, TERM and CI, plus `changes`."""
    env = {k: v for k, v in os.environ.items() if k not in ("NO_COLOR", "TERM", "CI")}
    env.update(changes)
    return mock.patch.dict(os.environ, env, clear=True)


def _verify_args():
    return argparse.Namespace(verify=True, export=False, format="jsonl", output=None)


class TestStderrSymbols(unittest.TestCase):
    def test_stdout_terminal_stderr_piped_gives_no_emoji_on_the_stderr_line(self):
        out, err = _Tty(), _Pipe()
        with _env(), mock.patch("sys.stdout", out), mock.patch("sys.stderr", err), \
                mock.patch("zn_gate.cli.verify_evidence_ledger", return_value={"valid": False, "error": "bad link"}):
            code = cmd_evidence(_verify_args())
        self.assertEqual(code, 1)
        self.assertIn("[!] Tamper detected: bad link", err.getvalue())
        self.assertNotIn(ALERT, err.getvalue())
        self.assertTrue(all(ord(c) < 0x80 or c in "\n\t" for c in err.getvalue()), err.getvalue())

    def test_both_terminals_keep_the_emoji_on_the_stderr_line(self):
        out, err = _Tty(), _Tty()
        with _env(), mock.patch("sys.stdout", out), mock.patch("sys.stderr", err), \
                mock.patch("zn_gate.cli.verify_evidence_ledger", return_value={"valid": False, "error": "bad link"}):
            cmd_evidence(_verify_args())
        self.assertIn(f"{ALERT} Tamper detected: bad link", err.getvalue())

    def test_lead_follows_the_stream_it_is_given(self):
        with _env(), mock.patch("sys.stdout", _Tty()):
            self.assertEqual(_lead(ALERT, _Pipe()), "[!] ")
            self.assertEqual(_lead(ALERT, _Tty()), f"{ALERT} ")
            self.assertEqual(_lead(ALERT), f"{ALERT} ")

    def test_without_a_stream_lead_uses_stdout(self):
        with _env(), mock.patch("sys.stdout", _Pipe()):
            self.assertEqual(_lead(CHECK), "[ok] ")
        with _env(), mock.patch("sys.stdout", _Tty()):
            self.assertEqual(_lead(SHIELD), f"{SHIELD} ")

    def test_no_color_term_dumb_and_ci_turn_the_symbol_off_on_a_stderr_terminal(self):
        for changes in ({"NO_COLOR": "1"}, {"TERM": "dumb"}, {"CI": "true"}):
            with self.subTest(changes=changes), _env(**changes):
                self.assertEqual(_lead(ALERT, _Tty()), "[!] ")

    def test_empty_no_color_keeps_the_symbol_on_a_stderr_terminal(self):
        with _env(NO_COLOR=""):
            self.assertEqual(_lead(ALERT, _Tty()), f"{ALERT} ")

    def test_a_terminal_that_cannot_encode_the_symbol_gets_the_marker(self):
        with _env():
            self.assertEqual(_lead(ALERT, _LegacyTty()), "[!] ")


if __name__ == "__main__":
    unittest.main()
