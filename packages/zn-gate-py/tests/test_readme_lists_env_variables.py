"""Every environment variable the Python package reads is described in the README Configuration list."""
import pathlib
import re
import unittest

PKG = pathlib.Path(__file__).resolve().parent.parent
SRC = PKG / "src" / "zn_gate"
README = PKG / "README.md"

# The ways this package reads an environment variable: os.environ.get / os.getenv,
# os.environ[...] (a read, not an assignment), env.get on a mapping passed in (verbose.py),
# env_flag(...) in rules.py, and the "env_dir" names of the coding agents (reach_history.py).
READ_PATTERNS = [
    re.compile(r"os\.(?:environ\.get|getenv)\(\s*['\"]([A-Z][A-Z0-9_]*)['\"]"),
    re.compile(r"os\.environ\[\s*['\"]([A-Z][A-Z0-9_]*)['\"]\s*\](?!\s*=(?!=))"),
    re.compile(r"\benv\.get\(\s*['\"]([A-Z][A-Z0-9_]*)['\"]"),
    re.compile(r"\benv_flag\(\s*['\"]([A-Z][A-Z0-9_]*)['\"]"),
    re.compile(r"\"env_dir\"\s*:\s*\"([A-Z][A-Z0-9_]*)\""),
]

# Names read from the environment that the README does not need to list: name -> reason.
IGNORED = {}


def environment_names():
    names = set()
    for path in SRC.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for pattern in READ_PATTERNS:
            names.update(pattern.findall(text))
    return names - set(IGNORED)


def configuration_section():
    text = README.read_text(encoding="utf-8")
    match = re.search(r"^## Configuration\n(.*?)(?=^## )", text, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else ""


class TestReadmeEnvVariables(unittest.TestCase):
    def test_scan_finds_known_reads(self):
        names = environment_names()
        for known in ("ZN_API_KEY", "ZN_HOME", "NO_COLOR", "CODEX_HOME", "ZN_BLOCK_TRUNCATED"):
            self.assertIn(known, names)

    def test_configuration_section_exists(self):
        self.assertTrue(configuration_section(), "README has no '## Configuration' section")

    def test_every_read_variable_is_described(self):
        section = configuration_section()
        missing = sorted(
            name
            for name in environment_names()
            if not re.search(rf"(?<![A-Za-z0-9_]){name}(?![A-Za-z0-9_])", section)
        )
        self.assertEqual(missing, [], "environment variables read by the package but not in the README Configuration list")


if __name__ == "__main__":
    unittest.main()
