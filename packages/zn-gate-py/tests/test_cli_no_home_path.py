"""CLI output never shows the absolute path of the home folder. HOME is a
temporary directory with a plain-text MCP config; every value is invented."""

import io
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from zn_gate.cli import main

FAKE = "ZNTESTFAKE" + "q8v3Lm9x2W"
CONFIG = '{"mcpServers": {"s": {"env": {"BRAVE_API_KEY": "%s"}}}}\n' % FAKE


class TestNoHomePath(unittest.TestCase):
    def setUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp())
        self.work = os.path.realpath(tempfile.mkdtemp())
        (Path(self.home) / ".cursor").mkdir()
        (Path(self.home) / ".cursor" / "mcp.json").write_text(CONFIG, encoding="utf-8")
        env = {"HOME": self.home, "USERPROFILE": self.home, "CODEX_HOME": "",
               "XDG_CONFIG_HOME": "", "APPDATA": "", "ZN_HOME": ""}
        patches = [mock.patch.dict(os.environ, env),
                   mock.patch("pathlib.Path.home", return_value=Path(self.home))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(shutil.rmtree, self.home, True)
        self.addCleanup(shutil.rmtree, self.work, True)

    def _run(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["zn-gate", *argv]), redirect_stdout(out), redirect_stderr(err):
            code = main()
        return code, out.getvalue() + err.getvalue()

    def _check(self, text):
        self.assertNotIn(self.home, text)
        self.assertNotIn(self.home.replace("\\", "/"), text)
        self.assertNotIn(FAKE, text)

    def test_scan_of_home_configs_shows_a_tilde_path(self):
        for fmt in ("text", "json", "github"):
            code, out = self._run("scan", self.work, "--include-home", "--format", fmt)
            self.assertEqual(code, 1)
            self.assertIn("~/.cursor/mcp.json" if fmt != "github" else "mcp.json", out)
            self._check(out)

    def test_status_stats_and_test_do_not_show_the_home_path(self):
        for argv in (("status",), ("stats",), ("test", "hello there")):
            _, out = self._run(*argv)
            self._check(out)


if __name__ == "__main__":
    unittest.main()
