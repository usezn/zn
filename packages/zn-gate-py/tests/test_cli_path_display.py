"""Tests for how cli.py shows a path: relative to the current folder, or as ~/ under HOME."""
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from zn_gate.cli import _home_display, _relative_to_cwd


class RelativeToCwdTest(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.old = os.getcwd()
        os.chdir(self.base)

    def tearDown(self):
        os.chdir(self.old)
        shutil.rmtree(self.base, ignore_errors=True)

    def test_inside_current_folder(self):
        got = _relative_to_cwd(os.path.join(self.base, "a", "b.txt"))
        self.assertEqual(got.replace(os.sep, "/"), "a/b.txt")

    def test_relative_input_stays_relative(self):
        self.assertEqual(_relative_to_cwd("x.txt"), "x.txt")

    def test_the_current_folder_itself(self):
        self.assertEqual(_relative_to_cwd(self.base), ".")

    def test_outside_current_folder(self):
        sub = os.path.join(self.base, "work")
        os.makedirs(sub)
        sibling = os.path.join(self.base, "other", "f.txt")
        os.chdir(sub)
        got = _relative_to_cwd(sibling)
        self.assertEqual(got.replace(os.sep, "/"), "../other/f.txt")

    def test_windows_style_path_is_a_plain_name_on_posix(self):
        if os.name == "nt":
            self.skipTest("backslashes are separators on Windows")
        got = _relative_to_cwd("C:\\Users\\example\\.env")
        self.assertEqual(got, "C:\\Users\\example\\.env")


class HomeDisplayTest(unittest.TestCase):
    def setUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp())
        env = {"HOME": self.home, "USERPROFILE": self.home}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.home, True)

    def test_file_under_home(self):
        got = _home_display(Path(self.home) / ".config" / "app.json")
        self.assertEqual(got, "~/.config/app.json")

    def test_home_with_trailing_slash_in_the_variable(self):
        with mock.patch.dict(os.environ, {"HOME": self.home + "/", "USERPROFILE": self.home + "/"}):
            got = _home_display(Path(self.home) / ".env")
        self.assertEqual(got, "~/.env")

    def test_path_given_with_trailing_slash(self):
        got = _home_display(Path(self.home + "/") / "dir" / "")
        self.assertEqual(got, "~/dir")

    def test_home_itself(self):
        self.assertEqual(_home_display(Path(self.home)), "~/.")

    def test_outside_home_is_unchanged(self):
        other = Path(tempfile.gettempdir()) / "zn-example-outside" / "f.txt"
        self.assertEqual(_home_display(other), str(other))

    def test_sibling_with_same_prefix_is_not_under_home(self):
        sibling = Path(self.home + "-other") / "f.txt"
        self.assertEqual(_home_display(sibling), str(sibling))

    def test_windows_style_path_is_unchanged(self):
        if os.name == "nt":
            self.skipTest("a drive path is a real path on Windows")
        p = Path("C:\\Users\\example\\.env")
        self.assertEqual(_home_display(p), str(p))


if __name__ == "__main__":
    unittest.main()
