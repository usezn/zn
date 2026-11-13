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


@unittest.skipIf(_META is None, "zn-gate is not installed")
class PackageMetadataTest(unittest.TestCase):
    def test_name(self):
        self.assertEqual(_META["Name"], "zn-gate")

    def test_version_is_a_release_or_prerelease(self):
        # X.Y.Z for a release; the release flow also publishes pre-releases in the PEP 440 form (1.16.0rc1, 1.16.0a1,
        # 1.16.0b1). Nothing else: no local versions, dev or post releases.
        self.assertRegex(_META["Version"], r"^\d+\.\d+\.\d+(?:(?:a|b|rc)[1-9]\d*)?$")

    def test_version_matches_module(self):
        self.assertEqual(_META["Version"], __version__)

    def test_minimum_python(self):
        match = re.fullmatch(r">=(\d+)\.(\d+)", _META["Requires-Python"] or "")
        self.assertIsNotNone(match, _META["Requires-Python"])
        self.assertGreaterEqual((int(match[1]), int(match[2])), (3, 10))


if __name__ == "__main__":
    unittest.main()
