"""
`zn-gate --version`, `--help` for every subcommand, and exit code 2 on an
unknown flag. The CLI runs as a real subprocess so the exit codes and the
output streams are the ones a user sees.
"""

import os
import subprocess
import sys
import unittest

from zn_gate import __version__
from zn_gate.cli import build_parser, known_commands

_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
_COMMANDS = sorted(known_commands(build_parser()))
# Positional arguments some commands need before a flag can be parsed.
_POSITIONAL = {"test": ["sample"], "analyze": ["sample"]}


def _zn(*args: str):
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )


class TestVersionOutput(unittest.TestCase):
    def test_version_flags_print_the_version_and_exit_0(self):
        for flag in ("--version", "-v", "-V"):
            with self.subTest(flag=flag):
                proc = _zn(flag)
                self.assertEqual(proc.returncode, 0)
                self.assertIn(f"zn-gate {__version__}", proc.stdout)
                self.assertIn("(rules:", proc.stdout)

    def test_version_command_prints_the_same_line(self):
        proc = _zn("version")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, _zn("--version").stdout)


class TestHelpOutput(unittest.TestCase):
    def test_every_expected_subcommand_is_known(self):
        self.assertEqual(
            _COMMANDS, ["analyze", "evidence", "scan", "stats", "status", "test"]
        )

    def test_top_level_help_lists_every_subcommand(self):
        proc = _zn("--help")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("usage: zn-gate", proc.stdout)
        for name in _COMMANDS:
            with self.subTest(command=name):
                self.assertIn(name, proc.stdout)

    def test_each_subcommand_help_prints_its_usage_and_exits_0(self):
        for name in _COMMANDS:
            with self.subTest(command=name):
                proc = _zn(name, "--help")
                self.assertEqual(proc.returncode, 0)
                self.assertIn(f"usage: zn-gate {name}", proc.stdout)
                self.assertIn("--help", proc.stdout)
                self.assertEqual(proc.stderr, "")


class TestUnknownFlag(unittest.TestCase):
    def test_unknown_top_level_flag_exits_2(self):
        proc = _zn("--no-such-flag")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("unrecognized arguments: --no-such-flag", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_unknown_flag_on_each_subcommand_exits_2(self):
        for name in _COMMANDS:
            with self.subTest(command=name):
                proc = _zn(name, *_POSITIONAL.get(name, []), "--no-such-flag")
                self.assertEqual(proc.returncode, 2)
                self.assertIn("--no-such-flag", proc.stderr)
                self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
