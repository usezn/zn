"""The RULES_VERSION header comment in each rules module must match the constant it documents."""
import importlib
import pathlib
import re
import unittest

PKG_DIR = pathlib.Path(__file__).resolve().parents[1] / "src" / "zn_gate"
HEADER = re.compile(r"^([A-Z_]*RULES_VERSION): (\d{4}-\d{2}-\d{2}\.\d+)$", re.MULTILINE)


class TestRulesHeaderVersion(unittest.TestCase):
    def test_header_versions_match_constants(self):
        checked = []
        for path in sorted(PKG_DIR.glob("*.py")):
            text = path.read_text(encoding="utf-8")
            module = importlib.import_module("zn_gate." + path.stem)
            for name, header_version in HEADER.findall(text):
                with self.subTest(file=path.name, constant=name):
                    self.assertEqual(
                        getattr(module, name), header_version,
                        f"{path.name} header says {name}: {header_version} but the constant is {getattr(module, name)}")
                checked.append((path.name, name))
        self.assertIn(("rules.py", "RULES_VERSION"), checked)


if __name__ == "__main__":
    unittest.main()
