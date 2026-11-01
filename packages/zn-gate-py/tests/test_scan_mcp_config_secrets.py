"""zn-gate scan: credentials written in plain text in MCP server configs. The
samples shared with the Node.js package, the config files of each agent, the
output formats, the user's own configs and speed on large and hostile files.
Every value is invented and assembled at run time; no output may contain it."""

import argparse
import io
import json
import os
import shutil
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from zn_gate import mcp_secrets as mcp
from zn_gate.cli import cmd_scan

SAMPLES_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "mcp_config_secret_samples.json"
FAKE = "ZNTESTFAKE" + "q8v3Lm9x2W"
NEEDLES = ("ZNTESTFAKE", "q8v3Lm9x2W")

MCP_JSON = """{
  "mcpServers": {
    "search": {
      "command": "npx",
      "args": ["-y", "pkg@1.2.3", "--api-key", "{V}"],
      "env": { "BRAVE_API_KEY": "{V}", "LOG_LEVEL": "debug" }
    },
    "remote": {
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer {V}" }
    }
  }
}
""".replace("{V}", FAKE)


class _Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, name, content, base=None):
        path = Path(base or self.dir) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="")

    def _scan(self, fmt, include_home=False, path=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cmd_scan(argparse.Namespace(path=path or self.dir, exclude=None, include=None, format=fmt,
                                               no_fail=False, include_home=include_home))
        return code, out.getvalue() + err.getvalue()

    def _json(self, **kw):
        code, out = self._scan("json", **kw)
        return code, json.loads(out), out

    def _no_value(self, text):
        for n in NEEDLES:
            self.assertNotIn(n, text)


class TestSharedSamples(unittest.TestCase):
    def test_each_credential_is_found_at_its_line_with_its_kind_and_name(self):
        if not SAMPLES_FILE.is_file():
            self.skipTest("packages/zn-gate is not next to this package: skipping the shared MCP samples")
        doc = json.loads(SAMPLES_FILE.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(doc["cases"]), 8)
        for c in doc["cases"]:
            got = [[f["line"], f["kind"], f["name"]] for f in
                   mcp.find_mcp_config_secrets("\n".join(c["lines"]).replace("{V}", FAKE), c.get("file", ""))]
            with self.subTest(case=c["name"]):
                self.assertEqual(got, c["expect"])
        for p in doc["paths"]:
            with self.subTest(path=p["path"]):
                self.assertEqual(mcp.is_mcp_config_path(p["path"]), p["mcp"])


class TestMcpSecrets(_Base):
    def test_results_never_hold_the_value(self):
        for f in mcp.find_mcp_config_secrets(MCP_JSON):
            self._no_value(json.dumps(f) + mcp.mcp_sample(f["kind"], f["name"]) +
                           mcp.mcp_next_step(f["kind"], f["name"]) + mcp.mcp_reason(f["kind"]))

    def test_which_files_are_mcp_configs(self):
        for f in (".mcp.json", "a/b/.cursor/mcp.json", ".vscode/mcp.json", "claude_desktop_config.json",
                  "x/mcp_config.json", ".codex/config.toml", ".gemini/settings.json", "opencode.jsonc",
                  "C:\\Users\\u\\.claude.json"):
            self.assertTrue(mcp.is_mcp_config_path(f), f)
        for f in ("config.toml", "settings.json", ".vscode/settings.json", "package.json", "mcp.json.bak", "notes.md"):
            self.assertFalse(mcp.is_mcp_config_path(f), f)

    def test_suggested_name_says_what_the_value_is_for(self):
        def s(n):
            return mcp.suggested_name(mcp.normalize_name(n))
        self.assertEqual(s("BRAVE_API_KEY"), "BRAVE_API_KEY")
        self.assertEqual(s("Authorization"), "MCP_AUTHORIZATION")
        self.assertEqual(s("token"), "MCP_TOKEN")
        self.assertEqual(s("githubPersonalAccessToken"), "GITHUB_PERSONAL_ACCESS_TOKEN")

    def test_next_step_is_plain(self):
        env = mcp.mcp_next_step("environment variable", "BRAVE_API_KEY")
        self.assertIn("npx -y zn-gate secret set BRAVE_API_KEY", env)
        self.assertIn("commands of the npm package, not of this Python package", env)
        self.assertIn("put run, --secrets, BRAVE_API_KEY, -- and the old command first in args", env)
        self.assertIn("environment variable BRAVE_API_KEY", env)
        self.assertNotIn("put __ZN_", env)
        arg = mcp.mcp_next_step("argument", "api-key")
        self.assertIn("put run, --secrets, MCP_API_KEY, -- and the old command first in args", arg)
        self.assertIn("a __ZN_MCP_API_KEY__ marker written in args is not filled in, because arguments are visible to other processes", arg)
        header = mcp.mcp_next_step("header", "Authorization")
        self.assertIn("${MCP_AUTHORIZATION}", header)
        self.assertNotIn("secret set", header)

    def test_large_and_hostile_files_are_read_in_linear_time(self):
        mb = 1024 * 1024
        inputs = {
            "many pairs": "{\n" + '  "A_TOKEN": "short",\n' * (2 * mb // 22) + "}\n",
            "many credentials": ('  "A_API_KEY": "' + FAKE + '",\n') * (2 * mb // 45),
            "one long line": "{" + '"K": "v", ' * (2 * mb // 10) + "}",
            "unterminated strings": ("\"a:\"b=\" 'x ") * (2 * mb // 14),
            "backslashes": '"' + "\\" * (2 * mb) + '"',
            "long bare words": "a" * (2 * mb) + ' = "x"',
            "flags without values": '"--token", \n' * (2 * mb // 12),
            "one huge value": '{ "A_TOKEN": "' + "x" * (2 * mb) + '" }',
        }
        for name, text in inputs.items():
            # CPU time of this process, not wall-clock: a busy machine must not fail a linear scan,
            # while a quadratic one still takes far longer than the limit.
            t0 = time.process_time()
            mcp.find_mcp_config_secrets(text)
            self.assertLess(time.process_time() - t0, 30, name)


class TestScanMcpConfigs(_Base):
    def test_each_agent_file_is_reported_by_type_file_and_line(self):
        for name in (".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", "claude_desktop_config.json",
                     ".gemini/antigravity/mcp_config.json", "cline_mcp_settings.json"):
            with self.subTest(file=name):
                shutil.rmtree(self.dir, ignore_errors=True)
                self.dir = tempfile.mkdtemp()
                self._write(name, MCP_JSON)
                code, data, out = self._json()
                self.assertEqual(code, 1)
                self._no_value(out)
                lines = {t["line"] for t in data["threats"] if t["type"] == "secret_leak"}
                self.assertTrue({5, 6, 10} <= lines)
                self.assertFalse({1, 7} & lines)
                flag = next(t for t in data["threats"] if t["line"] == 5)
                self.assertEqual(flag["rule"], "secret:mcp_config")
                for t in data["threats"]:
                    self.assertTrue(t["next_step"].startswith("Next: "))

    def test_codex_toml(self):
        self._write(".codex/config.toml",
                    '[mcp_servers.x]\ncommand = "npx"\n[mcp_servers.x.http_headers]\nAuthorization = "Bearer '
                    + FAKE + '"\n[mcp_servers.x.env]\nLOG_LEVEL = "debug"\n')
        code, data, out = self._json()
        self.assertEqual(code, 1)
        self._no_value(out)
        self.assertEqual([[t["line"], t["rule"]] for t in data["threats"]], [[4, "secret:mcp_config"]])

    def test_references_and_plain_settings_keep_a_config_clean(self):
        self._write(".mcp.json", json.dumps({"mcpServers": {
            "a": {"command": "npx", "args": ["-y", "pkg@1.2.3", "--api-key", "${API_KEY}", "--port", "8080"],
                  "env": {"BRAVE_API_KEY": "${BRAVE_API_KEY}", "LOG_LEVEL": "debug", "STRIPE_KEY": "__ZN_STRIPE_KEY__"}},
            "b": {"url": "https://mcp.example.com/sse", "headers": {"Authorization": "Bearer ${TOKEN}"}}}}, indent=2))
        code, data, _ = self._json()
        self.assertEqual(code, 0, data["threats"])
        self.assertEqual(data["total_secrets"], 0)

    def test_other_file_names_are_not_mcp_configs(self):
        self._write("servers.json", MCP_JSON)
        _, data, _ = self._json()
        self.assertFalse(any(t["rule"] == "secret:mcp_config" for t in data["threats"]))

    def test_a_value_never_reaches_another_rule_snippet_on_the_same_line(self):
        v2 = "ZNTESTFAKE" + "x7Pq4Rt8Yu1"
        multi = ('{\n  "mcpServers": { "s": { "command": "npx",\n    "args": ["-y", "x", "--api-key", "' + FAKE
                 + '", "--token=' + v2 + '"] } }\n}\n')
        single = ('{"mcpServers":{"b":{"command":"npx","env":{"API_KEY":"x"},"args":["--password","' + FAKE
                  + '","--token=' + v2 + '"]}}}')
        for name, text in (("multi-line", multi), ("single line", single)):
            with self.subTest(name):
                shutil.rmtree(self.dir, ignore_errors=True)
                self.dir = tempfile.mkdtemp()
                self._write(".mcp.json", text)
                for fmt in ("text", "json", "github"):
                    _, out = self._scan(fmt)
                    self._no_value(out)
                _, data, _ = self._json()
                self.assertEqual(len([t for t in data["threats"] if t["rule"] == "secret:mcp_config"]), 2)

    def test_a_credential_another_rule_also_knows_is_one_finding_with_the_mcp_next_step(self):
        self._write(".mcp.json", '{\n  "mcpServers": { "s": { "env": {\n    "GITHUB_TOKEN": "ghp_ZNTESTFAKE'
                    'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5" }\n  } } }\n')
        _, data, out = self._json()
        self._no_value(out)
        hits = [t for t in data["threats"] if t["line"] == 3]
        self.assertEqual(len(hits), 1)
        self.assertIn("zn-gate secret set GITHUB_TOKEN", hits[0]["next_step"])

    def test_the_key_claude_code_logs_in_with_is_left_alone(self):
        text = ('{ "primaryApiKey": "' + FAKE + '", "mcpServers": { "s": { "env": { "BRAVE_API_KEY": "' + FAKE + '" } } } }')
        self.assertEqual([f["name"] for f in mcp.find_mcp_config_secrets(text, "/home/u/.claude.json")], ["BRAVE_API_KEY"])
        self.assertEqual([f["name"] for f in mcp.find_mcp_config_secrets(text, "other.json")], ["primaryApiKey", "BRAVE_API_KEY"])

    def test_include_home_follows_a_link_inside_home_and_not_one_that_leaves_it(self):
        if os.name == "nt":
            self.skipTest("symbolic links need privileges on Windows")
        home = tempfile.mkdtemp()
        outside = tempfile.mkdtemp()
        try:
            self._write("dotfiles/cursor.json", MCP_JSON, base=home)
            self._write("mcp.json", MCP_JSON, base=outside)
            os.mkdir(os.path.join(home, ".cursor"))
            os.symlink(os.path.join(home, "dotfiles", "cursor.json"), os.path.join(home, ".cursor", "mcp.json"))
            os.symlink(os.path.join(outside, "mcp.json"), os.path.join(home, ".claude.json"))
            env = {"HOME": home, "USERPROFILE": home, "CODEX_HOME": "", "XDG_CONFIG_HOME": "", "APPDATA": ""}
            with mock.patch.dict(os.environ, env), mock.patch("pathlib.Path.home", return_value=Path(home)):
                _, data, _ = self._json(include_home=True)
            files = {t["file"] for t in data["threats"]}
            self.assertIn("~/.cursor/mcp.json", files)
            self.assertNotIn("~/.claude.json", files)
        finally:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(outside, ignore_errors=True)

    def test_text_and_github_output_never_show_the_value(self):
        self._write(".mcp.json", MCP_JSON)
        code, text = self._scan("text")
        self.assertEqual(code, 1)
        self._no_value(text)
        self.assertIn("secret:mcp_config", text)
        self.assertIn("Plaintext credential in an MCP server configuration", text)
        _, gh = self._scan("github")
        self._no_value(gh)
        self.assertIn("title=Secret found (secret%3Amcp_config)::Next: ", gh)

    def test_include_home_checks_the_users_own_configs(self):
        home = tempfile.mkdtemp()
        try:
            self._write(".cursor/mcp.json", MCP_JSON, base=home)
            self._write(".codex/config.toml", '[mcp_servers.x.env]\nBRAVE_API_KEY = "' + FAKE + '"\n', base=home)
            env = {"HOME": home, "USERPROFILE": home, "CODEX_HOME": "", "XDG_CONFIG_HOME": "", "APPDATA": ""}
            with mock.patch.dict(os.environ, env), mock.patch("pathlib.Path.home", return_value=Path(home)):
                code, _, _ = self._json()
                self.assertEqual(code, 3)  # no file was read
                code, data, out = self._json(include_home=True)
            self.assertEqual(code, 1)
            self._no_value(out)
            files = {t["file"] for t in data["threats"]}
            self.assertIn("~/.cursor/mcp.json", files)
            self.assertIn("~/.codex/config.toml", files)
            self.assertEqual(data["total_files"], 2)
        finally:
            shutil.rmtree(home, ignore_errors=True)


class TestReviewFixes(_Base):
    def test_a_second_credential_on_a_line_another_rule_reports_is_still_found(self):
        self._write(".mcp.json", '{ "mcpServers": { "s": { "env": { "GITHUB_TOKEN": "ghp_ZNTESTFAKE'
                    'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5", "DB_PASSWORD": "' + FAKE + '" } } } }\n')
        _, data, out = self._json()
        self._no_value(out)
        self.assertEqual(len([t for t in data["threats"] if t["line"] == 1]), 2)

    def test_a_home_config_over_2_mib_is_checked_for_mcp_credentials_only(self):
        home = tempfile.mkdtemp()
        try:
            padding = '  "history": "ordinary text that is not a credential",\n' * 60000
            self._write(".claude.json", "{\n" + padding + '  "mcpServers": { "s": { "env": { "BRAVE_API_KEY": "'
                        + FAKE + '" } } }\n}\n', base=home)
            env = {"HOME": home, "USERPROFILE": home, "CODEX_HOME": "", "XDG_CONFIG_HOME": "", "APPDATA": ""}
            with mock.patch.dict(os.environ, env), mock.patch("pathlib.Path.home", return_value=Path(home)):
                _, data, out = self._json(include_home=True)
            self._no_value(out)
            self.assertEqual(data["total_skipped"], 0)
            self.assertEqual([[t["file"], t["rule"]] for t in data["threats"]], [["~/.claude.json", "secret:mcp_config"]])
        finally:
            shutil.rmtree(home, ignore_errors=True)

    def test_a_home_file_inside_the_scanned_folder_is_reported_once(self):
        home = tempfile.mkdtemp()
        try:
            self._write(".cursor/mcp.json", MCP_JSON, base=home)
            env = {"HOME": home, "USERPROFILE": home, "CODEX_HOME": "", "XDG_CONFIG_HOME": "", "APPDATA": ""}
            with mock.patch.dict(os.environ, env), mock.patch("pathlib.Path.home", return_value=Path(home)):
                _, data, _ = self._json(include_home=True, path=home)
            self.assertEqual(data["total_files"], 1)
        finally:
            shutil.rmtree(home, ignore_errors=True)

    def test_a_suggested_name_never_ends_with_an_underscore(self):
        self.assertFalse(mcp.suggested_name(mcp.normalize_name("a" * 55 + "_token")).endswith("_"))

    def test_the_login_key_is_not_a_finding_of_any_rule_in_a_small_file_too(self):
        home = tempfile.mkdtemp()
        try:
            key = "sk-ant-api03-" + "ZNTESTFAKE" + "q8v3Lm9x2W" * 8
            self._write(".claude.json", '{\n  "primaryApiKey": "' + key + '",\n  "mcpServers": { "s": { "env": { "BRAVE_API_KEY": "'
                        + FAKE + '" } } }\n}\n', base=home)
            env = {"HOME": home, "USERPROFILE": home, "CODEX_HOME": "", "XDG_CONFIG_HOME": "", "APPDATA": ""}
            with mock.patch.dict(os.environ, env), mock.patch("pathlib.Path.home", return_value=Path(home)):
                _, data, out = self._json(include_home=True)
            self._no_value(out)
            self.assertEqual([[t["line"], t["rule"]] for t in data["threats"]], [[3, "secret:mcp_config"]])
        finally:
            shutil.rmtree(home, ignore_errors=True)

    def test_include_home_does_not_follow_a_link_on_a_parent_folder_out_of_home(self):
        if os.name == "nt":
            self.skipTest("symbolic links need privileges on Windows")
        home = tempfile.mkdtemp()
        outside = tempfile.mkdtemp()
        try:
            self._write("config.toml", '[mcp_servers.x.env]\nBRAVE_API_KEY = "' + FAKE + '"\n', base=outside)
            os.symlink(outside, os.path.join(home, ".codex"))
            env = {"HOME": home, "USERPROFILE": home, "CODEX_HOME": "", "XDG_CONFIG_HOME": "", "APPDATA": ""}
            with mock.patch.dict(os.environ, env), mock.patch("pathlib.Path.home", return_value=Path(home)):
                _, data, _ = self._json(include_home=True)
            self.assertEqual(data["threats"], [])
        finally:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(outside, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
