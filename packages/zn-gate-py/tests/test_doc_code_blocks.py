"""Python code blocks in the docs parse and import only exported names."""
import ast
import importlib
import os
import re
import unittest

PKG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO_ROOT = os.path.abspath(os.path.join(PKG_DIR, "..", ".."))
DOCS_DIR = os.path.join(REPO_ROOT, "docs")
API_REFERENCE = os.path.join(DOCS_DIR, "api-reference.md")
README = os.path.join(PKG_DIR, "README.md")

# Names shown in the docs that the module does not export. Each has a reason.
KNOWN_UNEXPORTED = {
    # "module.name": "reason",
}

FENCE = re.compile(r"^```(?:python|py)\s*\n(.*?)^```", re.S | re.M)


def blocks(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    return [m.group(1) for m in FENCE.finditer(text)]


def imported_names(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            if node.module.split(".")[0] != "zn_gate":
                continue
            for alias in node.names:
                yield node.module, alias.name
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] == "zn_gate":
                    yield alias.name, None


@unittest.skipUnless(os.path.isdir(DOCS_DIR), "docs folder is missing")
class TestDocCodeBlocks(unittest.TestCase):
    def _check(self, path):
        self.assertTrue(os.path.isfile(path), path)
        found = blocks(path)
        self.assertTrue(found, "no python blocks in " + path)
        for i, code in enumerate(found, 1):
            label = "%s block %d" % (os.path.basename(path), i)
            try:
                tree = ast.parse(code)
            except SyntaxError as exc:
                self.fail("%s does not compile: %s" % (label, exc))
            for module, name in imported_names(tree):
                mod = importlib.import_module(module)
                if name is None or name == "*":
                    continue
                key = module + "." + name
                if key in KNOWN_UNEXPORTED:
                    continue
                exported = getattr(mod, "__all__", None)
                if module == "zn_gate":
                    self.assertIn(name, exported, "%s: %s not in __all__" % (label, key))
                self.assertTrue(hasattr(mod, name), "%s: %s missing" % (label, key))

    def test_api_reference_blocks(self):
        self._check(API_REFERENCE)

    def test_readme_blocks(self):
        self._check(README)


if __name__ == "__main__":
    unittest.main()
