"""
`python -m zn_gate` runs the same CLI as the `zn-gate` command: the same
output and the same exit codes. Each case runs as a real subprocess, so the
streams and the exit code are the ones a user sees.
"""

import os
import subprocess
import sys
import unittest

from zn_gate import __version__

_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")

# What the `zn-gate` console script runs (pyproject.toml: zn_gate.cli:main),
# with argv set the way the script wrapper sets it.
_CONSOLE_CODE = (
    "import sys; from zn_gate.cli import main; "
    "sys.argv = ['zn-gate'] + sys.argv[1:]; sys.exit(main())"
)


def _env():
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _module(*args: str):
    return subprocess.run(
        [sys.executable, "-m", "zn_gate", *args],
        capture_output=True,
        text=True,
        env=_env(),
        timeout=60,
    )


def _console(*args: str):
    return subprocess.run(
        [sys.executable, "-c", _CONSOLE_CODE, *args],
        capture_output=True,
        text=True,
        env=_env(),
        timeout=60,
    )


class TestModuleMatchesConsoleScript(unittest.TestCase):
    def test_version_matches_console_script(self):
        mod, con = _module("--version"), _console("--version")
        self.assertEqual(mod.returncode, 0)
        self.assertEqual(con.returncode, 0)
        self.assertEqual(mod.stdout, con.stdout)
        self.assertIn(f"zn-gate {__version__}", mod.stdout)

    def test_help_matches_console_script(self):
        for args in (("--help",), ("-h",), ("scan", "--help")):
            with self.subTest(args=args):
                mod, con = _module(*args), _console(*args)
                self.assertEqual(mod.returncode, 0)
                self.assertEqual(con.returncode, 0)
                self.assertEqual(mod.stdout, con.stdout)
                self.assertTrue(mod.stdout.startswith("usage: zn-gate"))

    def test_unknown_flag_exit_code_and_stderr_match_console_script(self):
        mod, con = _module("--no-such-flag"), _console("--no-such-flag")
        self.assertEqual(mod.returncode, 2)
        self.assertEqual(mod.returncode, con.returncode)
        self.assertEqual(mod.stderr, con.stderr)
        self.assertEqual(mod.stdout, con.stdout)


if __name__ == "__main__":
    unittest.main()
