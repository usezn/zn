"""Tests for check-python-pack.py. Run: python -I -m unittest .github/scripts/test_check_python_pack.py"""
import contextlib
import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("check_python_pack", os.path.join(HERE, "check-python-pack.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

TOP = "zn_gate-9.9.9"
GOOD_WHEEL = {
    "zn_gate/__init__.py": b"x = 1\n",
    "zn_gate/py.typed": b"",
    "zn_gate/integrations/crewai.py": b"",
    "zn_gate-9.9.9.dist-info/METADATA": b"",
    "zn_gate-9.9.9.dist-info/WHEEL": b"",
    "zn_gate-9.9.9.dist-info/RECORD": b"",
    "zn_gate-9.9.9.dist-info/licenses/LICENSE": b"",
}
GOOD_SDIST = {
    "PKG-INFO": b"",
    "LICENSE": b"",
    "README.md": b"",
    "pyproject.toml": b"",
    "setup.cfg": b"",
    "src/zn_gate/__init__.py": b"",
    "src/zn_gate/py.typed": b"",
    "src/zn_gate.egg-info/SOURCES.txt": b"",
}


class PackCheck(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def wheel(self, files):
        path = os.path.join(self.dir.name, "zn_gate-9.9.9-py3-none-any.whl")
        with zipfile.ZipFile(path, "w") as z:
            for name, data in files.items():
                z.writestr(name, data)
        return path

    def sdist(self, files):
        path = os.path.join(self.dir.name, TOP + ".tar.gz")
        with tarfile.open(path, "w:gz") as t:
            d = tarfile.TarInfo(TOP)
            d.type = tarfile.DIRTYPE
            t.addfile(d)
            for name, data in files.items():
                info = tarfile.TarInfo(f"{TOP}/{name}")
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
        return path

    def errors(self, path):
        with contextlib.redirect_stdout(io.StringIO()):
            return mod.check(path)

    def test_clean_archives_pass(self):
        self.assertEqual(self.errors(self.wheel(GOOD_WHEEL)), [])
        self.assertEqual(self.errors(self.sdist(GOOD_SDIST)), [])

    def test_tests_in_sdist_fail(self):
        errs = self.errors(self.sdist({**GOOD_SDIST, "tests/test_rules.py": b""}))
        self.assertTrue(any("test suite" in e for e in errs))

    def test_env_key_and_unknown_files_fail(self):
        errs = self.errors(self.wheel({**GOOD_WHEEL, "zn_gate/.env": b"", "zn_gate/server.pem": b"", "extra.txt": b""}))
        self.assertTrue(any("env file" in e for e in errs))
        self.assertTrue(any("key or certificate" in e for e in errs))
        self.assertTrue(any("allowlist" in e and "extra.txt" in e for e in errs))

    def test_big_file_fails(self):
        errs = self.errors(self.wheel({**GOOD_WHEEL, "zn_gate/big.py": b"#" * (201 * 1024)}))
        self.assertTrue(any("over 200 KB" in e for e in errs))

    def test_unsafe_path_fails(self):
        errs = self.errors(self.wheel({**GOOD_WHEEL, "../evil.py": b""}))
        self.assertTrue(any("unsafe path" in e for e in errs))


if __name__ == "__main__":
    unittest.main()
