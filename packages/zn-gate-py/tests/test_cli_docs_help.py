"""
Every top-level command that docs/cli.md documents and the Python CLI
implements answers `--help` with exit code 0. The test reads the docs, so a
newly documented command that the Python CLI also has is checked at once.
Commands that exist only in the npm package are skipped here.
"""

import os
import re
import subprocess
import sys
import unittest

from zn_gate.cli import build_parser, known_commands

_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = os.path.join(_HERE, "..", "src")
_DOC = os.path.join(_HERE, "..", "..", "..", "docs", "cli.md")
# `version` is handled before argument parsing, so the parser does not list it.
_PYTHON_COMMANDS = set(known_commands(build_parser())) | {"version"}


def _documented_commands():
    with open(_DOC, encoding="utf-8") as fh:
        text = fh.read()
    # Top-level commands only: "### `name`" headings.
    return sorted(set(re.findall(r"^### `([a-z][a-z0-9-]*)`\s*$", text, re.M)))


def _zn(*args):
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


class TestDocumentedCommandsHelp(unittest.TestCase):
    def test_docs_list_commands(self):
        self.assertIn("scan", _documented_commands())

    def test_every_python_command_is_documented(self):
        missing = _PYTHON_COMMANDS - set(_documented_commands())
        self.assertEqual(missing, set())

    def test_documented_python_commands_answer_help_with_exit_0(self):
        checked = [c for c in _documented_commands() if c in _PYTHON_COMMANDS]
        self.assertTrue(checked)
        for name in checked:
            with self.subTest(command=name):
                proc = _zn(name, "--help")
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertTrue(proc.stdout.strip())


if __name__ == "__main__":
    unittest.main()
