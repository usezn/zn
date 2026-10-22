"""The RULES_VERSION named in the module header of rules.py must equal the RULES_VERSION constant."""

import re
import unittest
from pathlib import Path

RULES_FILE = Path(__file__).resolve().parents[1] / "src" / "zn_gate" / "rules.py"


class RulesHeaderVersion(unittest.TestCase):
    def test_header_version_matches_constant(self):
        src = RULES_FILE.read_text(encoding="utf-8")
        header = re.search(r"^RULES_VERSION:\s*(\S+)\s*$", src, re.M)
        constant = re.search(r'^RULES_VERSION\s*=\s*"([^"]+)"', src, re.M)
        self.assertIsNotNone(header, "header line 'RULES_VERSION: <version>' not found")
        self.assertIsNotNone(constant, "constant 'RULES_VERSION = \"<version>\"' not found")
        self.assertEqual(header.group(1), constant.group(1))


if __name__ == "__main__":
    unittest.main()
