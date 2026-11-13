"""Read-only checks for the PEP 561 typed marker (no build is run)."""

import re
import unittest
from pathlib import Path

import zn_gate

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = PACKAGE_ROOT / "pyproject.toml"


def _package_data_section() -> str:
    text = PYPROJECT.read_text(encoding="utf-8")
    match = re.search(
        r"^\[tool\.setuptools\.package-data\]\s*\n(.*?)(?=^\[|\Z)", text, re.M | re.S
    )
    assert match, "package-data section is missing"
    return match.group(1)


class TypedMarkerTests(unittest.TestCase):
    def test_marker_file_exists_in_imported_package(self):
        marker = Path(zn_gate.__file__).parent / "py.typed"
        self.assertTrue(marker.is_file())

    def test_marker_is_in_source_tree(self):
        marker = PACKAGE_ROOT / "src" / "zn_gate" / "py.typed"
        self.assertTrue(marker.is_file())

    def test_marker_has_no_content_beyond_comments(self):
        marker = PACKAGE_ROOT / "src" / "zn_gate" / "py.typed"
        data = marker.read_text(encoding="utf-8")
        lines = [ln for ln in data.splitlines() if ln.strip() and not ln.startswith("#")]
        self.assertEqual(lines, [])

    def test_pyproject_lists_marker_as_package_data(self):
        section = _package_data_section()
        self.assertRegex(section, r'zn_gate\s*=\s*\[[^\]]*"py\.typed"[^\]]*\]')

    def test_pyproject_has_typed_classifier(self):
        text = PYPROJECT.read_text(encoding="utf-8")
        self.assertIn('"Typing :: Typed"', text)

    def test_package_data_key_matches_real_package(self):
        self.assertEqual(zn_gate.__name__, "zn_gate")
        self.assertTrue((PACKAGE_ROOT / "src" / "zn_gate" / "__init__.py").is_file())


if __name__ == "__main__":
    unittest.main()
