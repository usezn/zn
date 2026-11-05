"""The package declares no runtime dependencies, and every optional extra
points at a framework that has a module in zn_gate/integrations."""

import re
import sys
import unittest
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # Python 3.10 has no tomllib; tomli is the same parser
    import tomli as tomllib

ROOT = Path(__file__).resolve().parent.parent
INTEGRATIONS = ROOT / "src" / "zn_gate" / "integrations"

# Distribution name -> integration module that uses it.
FRAMEWORK_MODULES = {
    "langchain-core": "langchain",
    "llama-index-core": "llamaindex",
    "crewai": "crewai",
}


def _name(requirement):
    return re.split(r"[<>=!~;\[ ]", requirement, maxsplit=1)[0].lower()


class PyprojectDependenciesTest(unittest.TestCase):
    def setUp(self):
        with open(ROOT / "pyproject.toml", "rb") as fh:
            self.project = tomllib.load(fh)["project"]

    def test_no_runtime_dependencies(self):
        self.assertEqual(self.project.get("dependencies", []), [])

    def test_extras_match_integration_modules(self):
        extras = self.project.get("optional-dependencies", {})
        self.assertTrue(extras)
        for extra, requirements in extras.items():
            for requirement in requirements:
                name = _name(requirement)
                self.assertIn(name, FRAMEWORK_MODULES, f"{extra}: {name}")
                module = INTEGRATIONS / f"{FRAMEWORK_MODULES[name]}.py"
                self.assertTrue(module.is_file(), f"{extra}: missing {module.name}")


if __name__ == "__main__":
    unittest.main()
