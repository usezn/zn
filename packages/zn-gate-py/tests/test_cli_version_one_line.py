"""`zn-gate version` and `zn-gate --version` print exactly one line, "zn-gate <version> (rules: <rules>)". The version is
the one in pyproject.toml and in zn_gate.__version__ and, when the package is installed, in its installed metadata.
The CLI runs as a real subprocess from the source tree."""

import os
import re
import subprocess
import sys
import unittest
from importlib import metadata

from zn_gate import __version__

_PKG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
_SRC = os.path.join(_PKG, "src")
_LINE = re.compile(r"zn-gate (\d+\.\d+\.\d+) \(rules: [^()\s]+\)")

try:
    _META = metadata.metadata("zn-gate")
except metadata.PackageNotFoundError:  # not installed, e.g. run from source
    _META = None


def _pyproject_version():
    with open(os.path.join(_PKG, "pyproject.toml"), encoding="utf-8") as fh:
        match = re.search(r'^version = "([^"]+)"', fh.read(), re.M)
    return match.group(1) if match else None


def _zn(*args: str):
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )


class TestVersionIsOneLine(unittest.TestCase):
    def test_version_forms_print_exactly_one_line(self):
        for args in (("version",), ("--version",)):
            with self.subTest(args=args):
                proc = _zn(*args)
                self.assertEqual(proc.returncode, 0)
                self.assertEqual(proc.stderr, "")
                self.assertTrue(proc.stdout.endswith("\n"), repr(proc.stdout))
                lines = proc.stdout.splitlines()
                self.assertEqual(len(lines), 1, repr(proc.stdout))
                self.assertRegex(lines[0], _LINE)

    def test_version_equals_pyproject_and_module_version(self):
        expected = _pyproject_version()
        self.assertIsNotNone(expected, "no version line in pyproject.toml")
        self.assertEqual(expected, __version__)
        match = _LINE.fullmatch(_zn("version").stdout.splitlines()[0])
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), expected)

    @unittest.skipIf(_META is None, "zn-gate is not installed")
    def test_version_equals_installed_metadata(self):
        match = _LINE.fullmatch(_zn("--version").stdout.splitlines()[0])
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), _META["Version"])


if __name__ == "__main__":
    unittest.main()
