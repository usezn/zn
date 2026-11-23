"""
Package metadata as seen by an installed copy: distribution name, version
string format, and the minimum supported Python version.
"""

import re
import unittest
from importlib import metadata

from zn_gate import __version__

try:
    _META = metadata.metadata("zn-gate")
except metadata.PackageNotFoundError:  # not installed, e.g. run from source
    _META = None

# A final version (1.16.0) or a PEP 440 pre-release of one (1.16.0a1, 1.16.0b2, 1.16.0rc1).
_VERSION_RE = r"^\d+\.\d+\.\d+((a|b|rc)\d+)?$"


@unittest.skipIf(_META is None, "zn-gate is not installed")
class PackageMetadataTest(unittest.TestCase):
    def test_name(self):
        self.assertEqual(_META["Name"], "zn-gate")

    def test_version_is_semver_or_prerelease(self):
        self.assertRegex(_META["Version"], _VERSION_RE)

    def test_version_matches_module(self):
        self.assertEqual(_META["Version"], __version__)

    def test_minimum_python(self):
        match = re.fullmatch(r">=(\d+)\.(\d+)", _META["Requires-Python"] or "")
        self.assertIsNotNone(match, _META["Requires-Python"])
        self.assertGreaterEqual((int(match[1]), int(match[2])), (3, 10))


class VersionPatternTest(unittest.TestCase):
    def test_accepts_final_and_prerelease(self):
        for good in ("1.16.0", "1.16.0a1", "1.16.0b2", "1.16.0rc1", "1.16.0rc12"):
            self.assertRegex(good, _VERSION_RE)

    def test_rejects_other_shapes(self):
        for bad in ("1.16", "1.16.0rc", "1.16.0-rc.1", "1.16.0.dev1", "1.16.0rc1+local"):
            self.assertNotRegex(bad, _VERSION_RE)


if __name__ == "__main__":
    unittest.main()
