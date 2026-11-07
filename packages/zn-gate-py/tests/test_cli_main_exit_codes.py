"""
Exit codes and output streams of `zn-gate` main() for the entry cases that
need no files: no arguments, an unknown command, a misspelled command,
--help and a closed standard output. The CLI runs as a real subprocess.
"""

import os
import subprocess
import sys
import unittest

_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def _env():
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _zn(*args: str):
    return subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", *args],
        capture_output=True,
        text=True,
        env=_env(),
        timeout=60,
    )


class TestMainExitCodes(unittest.TestCase):
    def test_no_arguments_prints_the_usage_and_exits_0(self):
        proc = _zn()
        self.assertEqual(proc.returncode, 0)
        self.assertIn("usage: zn-gate", proc.stdout)
        self.assertEqual(proc.stderr, "")

    def test_unknown_command_exits_1_with_a_hint_on_stderr(self):
        proc = _zn("frobnicate")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stdout, "")
        self.assertIn("Unknown command: frobnicate", proc.stderr)
        self.assertIn("zn-gate --help", proc.stderr)

    def test_misspelled_command_is_reported_as_unknown_without_a_suggestion(self):
        for typo in ("statu", "scna", "Status"):
            with self.subTest(typo=typo):
                proc = _zn(typo)
                self.assertEqual(proc.returncode, 1)
                self.assertEqual(proc.stdout, "")
                self.assertIn(f"Unknown command: {typo}", proc.stderr)
                self.assertNotIn("Did you mean", proc.stderr)

    def test_help_flags_print_the_usage_and_exit_0(self):
        for flag in ("--help", "-h"):
            with self.subTest(flag=flag):
                proc = _zn(flag)
                self.assertEqual(proc.returncode, 0)
                self.assertIn("usage: zn-gate", proc.stdout)
                self.assertEqual(proc.stderr, "")


@unittest.skipIf(os.name == "nt", "closed pipe behaviour is checked on POSIX")
class TestClosedStandardOutput(unittest.TestCase):
    def test_closed_stdout_ends_the_process_with_a_failure_and_no_hang(self):
        for args in (["--help"], [], ["version"]):
            with self.subTest(args=args):
                proc = subprocess.Popen(
                    [sys.executable, "-m", "zn_gate.cli", *args],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=_env(),
                )
                # The reader goes away before the CLI writes anything.
                proc.stdout.close()
                err = proc.stderr.read()
                proc.stderr.close()
                code = proc.wait(timeout=60)
                self.assertNotEqual(code, 0)
                self.assertIn(b"BrokenPipeError", err)


if __name__ == "__main__":
    unittest.main()
