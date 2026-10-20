"""Edge cases of the MCP configuration credential check: broken files, nested
blocks, values that already hold a reference, odd paths, and the same results
as the Node.js package on the same configs. Every value is invented and
assembled at run time."""

import json
import ntpath
import posixpath
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

from zn_gate import mcp_secrets as mcp

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
NODE_LIB = NODE_PKG / "lib" / "mcp-secrets.js"
SHARED_FIXTURE = NODE_PKG / "test" / "fixtures" / "mcp_config_secret_samples.json"
FAKE = "ZNTESTFAKE" + "q8v3Lm9x2W"

# Reads {"cases": [{"text", "file"}]} on stdin; prints one result per case.
_NODE_RUNNER = """
const m = require(process.argv[1]);
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const cases = JSON.parse(raw).cases;
  const out = cases.map((c) => {
    const spans = m.findMcpConfigSecretSpans(c.text, { file: c.file });
    return {
      findings: m.findMcpConfigSecrets(c.text, { file: c.file }),
      spans: spans,
      masked: m.maskMcpValues(c.text, spans),
      isConfig: m.isMcpConfigPath(c.file),
    };
  });
  process.stdout.write(JSON.stringify(out));
});
"""

_NODE_HELPERS = (
    "const m=require(process.argv[1]);const n=JSON.parse(process.argv[2]);"
    "process.stdout.write(JSON.stringify(n.map(x=>[m.normalizeName(x),m.isSecretName(m.normalizeName(x)),"
    "m.suggestedName(m.normalizeName(x)),m.mcpNextStep('environment variable',x),m.mcpNextStep('header',x),"
    "m.mcpSample('argument',x),m.mcpSample('URL',x),m.mcpSample('header',x)])))"
)


def _kinds(text, file=""):
    return [(f["line"], f["kind"], f["name"]) for f in mcp.find_mcp_config_secrets(text, file)]


class TestBrokenFiles(unittest.TestCase):
    def test_broken_json_is_still_checked_and_never_raises(self):
        broken = [
            '{ "mcpServers": { "a": { "env": { "A_API_KEY": "%s",' % FAKE,  # cut off
            '{ "env": { "A_API_KEY": "%s" }, }}}}]]' % FAKE,  # extra closers
            '{ "env": { "A_API_KEY": "%s" ' % FAKE + "\n" + '"B_TOKEN": "%s" }' % FAKE,  # missing comma
            '{ // comment\n "A_API_KEY": "%s" /* c */ }' % FAKE,
            "\ufeff" + '{ "A_API_KEY": "%s" }' % FAKE,  # byte order mark
        ]
        for text in broken:
            with self.subTest(text=text[:30]):
                got = mcp.find_mcp_config_secrets(text)
                self.assertTrue(got, "a credential in a broken file must still be found")
                self.assertTrue(all(f["kind"] == "environment variable" for f in got))

    def test_broken_toml_is_still_checked_and_never_raises(self):
        toml = '[mcp_servers.a\nenv = { A_API_KEY = "%s"\n[[bad\nB_TOKEN = "%s" ===\n' % (FAKE, FAKE)
        self.assertEqual([g[2] for g in _kinds(toml)], ["A_API_KEY", "B_TOKEN"])

    def test_garbage_empty_and_binary_input_report_nothing_and_do_not_raise(self):
        for text in ("", "\n\n", "{", "}", '"', "'", "=", ":", '"="', "\x00\x01\x02", "\ufffd" * 50,
                     '"A_TOKEN"', '"A_TOKEN":', '"A_TOKEN": "', "A_TOKEN =", '"--api-key"', "[" * 5000, "\r\r\r"):
            with self.subTest(text=repr(text[:20])):
                self.assertEqual(mcp.find_mcp_config_secrets(text), [])
                self.assertEqual(mcp.mask_mcp_values(text, mcp.find_mcp_config_secret_spans(text)), text)

    def test_unterminated_string_hides_nothing_on_the_next_line(self):
        text = '{ "x": "abc\n"A_API_KEY": "%s" }' % FAKE
        self.assertEqual(_kinds(text), [(2, "environment variable", "A_API_KEY")])

    def test_a_file_name_that_is_not_text_does_not_raise(self):
        self.assertEqual(_kinds('"A_TOKEN": "%s"' % FAKE, file=None), [(1, "environment variable", "A_TOKEN")])  # type: ignore[arg-type]


class TestNestedBlocks(unittest.TestCase):
    def test_credentials_at_any_depth_are_found_at_their_own_line(self):
        text = "\n".join([
            "{",
            '  "mcpServers": {',
            '    "a": {',
            '      "env": {',
            '        "inner": { "deep": { "A_API_KEY": "%s" } },' % FAKE,
            '        "B_TOKEN": "%s"' % FAKE,
            "      }",
            "    }",
            "  }",
            "}",
        ])
        self.assertEqual(_kinds(text), [(5, "environment variable", "A_API_KEY"), (6, "environment variable", "B_TOKEN")])

    def test_same_name_in_two_servers_is_reported_for_each_line(self):
        text = "\n".join(['{"s1": {"env": {"A_TOKEN": "%s"}},' % FAKE, ' "s2": {"env": {"A_TOKEN": "%s"}}}' % FAKE])
        self.assertEqual([g[0] for g in _kinds(text)], [1, 2])

    def test_two_credentials_on_one_line_are_both_found(self):
        text = '{"env": {"A_TOKEN": "%s", "B_SECRET": "%s"}}' % (FAKE, FAKE)
        self.assertEqual([g[2] for g in _kinds(text)], ["A_TOKEN", "B_SECRET"])

    def test_toml_inline_and_sub_tables(self):
        text = "\n".join([
            "[mcp_servers.a.env]",
            'A_API_KEY = "%s"' % FAKE,
            "[mcp_servers.b]",
            'env = { B_TOKEN = "%s", LOG = "debug" }' % FAKE,
            "[mcp_servers.b.http_headers]",
            'Authorization = "Bearer %s"' % FAKE,
        ])
        self.assertEqual(_kinds(text), [(2, "environment variable", "A_API_KEY"), (4, "environment variable", "B_TOKEN"),
                                        (6, "header", "Authorization")])

    def test_a_flag_and_its_value_across_lines_inside_nested_args(self):
        text = '{"a": {"args": [\n "--api-key",\n // note\n "%s"\n]}}' % FAKE
        self.assertEqual(_kinds(text), [(4, "argument", "api-key")])


class TestExistingReferences(unittest.TestCase):
    def test_a_value_that_already_holds_a_reference_is_not_a_credential(self):
        refs = ["__ZN_BRAVE_API_KEY__", "${BRAVE_API_KEY}", "${env:BRAVE_API_KEY}", "{env:BRAVE_API_KEY}", "$BRAVE_API_KEY",
                "%BRAVE_API_KEY%", "{{ secrets.brave }}", "$(pass brave)", "<your-key-here>", "[REDACTED]",
                "Bearer __ZN_MCP_AUTHORIZATION__", "Bearer ${TOKEN}"]
        for ref in refs:
            with self.subTest(ref=ref):
                text = '{"env": {"BRAVE_API_KEY": "%s"}, "headers": {"Authorization": "%s"}}' % (ref, ref)
                self.assertEqual(mcp.find_mcp_config_secrets(text), [])
                self.assertEqual(mcp.find_mcp_config_secret_spans(text), [])

    def test_a_marker_in_args_and_urls_is_left_alone(self):
        text = '{"args": ["--api-key", "__ZN_A_KEY__", "--token=__ZN_T__", "https://h.example.com/m?api_key=__ZN_U__"]}'
        self.assertEqual(mcp.find_mcp_config_secrets(text), [])

    def test_a_marker_inside_a_longer_value_is_not_reported_and_not_masked(self):
        text = '{"A_TOKEN": "prefix-__ZN_X__-%s"}' % FAKE
        self.assertEqual(mcp.find_mcp_config_secrets(text), [])
        self.assertEqual(mcp.mask_mcp_values(text, mcp.find_mcp_config_secret_spans(text)), text)

    def test_masking_twice_changes_nothing_the_second_time(self):
        text = '{"A_API_KEY": "%s", "args": ["--token=%s"]}' % (FAKE, FAKE)
        once = mcp.mask_mcp_values(text, mcp.find_mcp_config_secret_spans(text))
        self.assertNotIn(FAKE, once)
        self.assertEqual(once.count("[REDACTED_MCP]"), 2)
        self.assertEqual(mcp.find_mcp_config_secret_spans(once), [])
        self.assertEqual(mcp.mask_mcp_values(once, mcp.find_mcp_config_secret_spans(once)), once)

    def test_masking_keeps_the_line_count_and_the_text_around_each_value(self):
        text = '{\n  "A_API_KEY": "%s",\r\n  "B": "keep"\n}\n' % FAKE
        out = mcp.mask_mcp_values(text, mcp.find_mcp_config_secret_spans(text))
        self.assertEqual(out, '{\n  "A_API_KEY": "[REDACTED_MCP]",\r\n  "B": "keep"\n}\n')

    def test_overlapping_spans_are_masked_once(self):
        spans: List[Dict[str, object]] = [{"start": 2, "end": 6}, {"start": 4, "end": 8}, {"start": 2, "end": 4}]
        self.assertEqual(mcp.mask_mcp_values("0123456789", spans), "01[REDACTED_MCP]6789")


class TestPathsAndText(unittest.TestCase):
    def test_paths_with_spaces_and_unicode(self):
        for p in ("/home/u/My Projects/app one/.mcp.json", "/home/u/proyecto ñandú/.cursor/mcp.json",
                  "/home/u/日本語/フォルダ/.mcp.json", "/home/u/📁 dir/claude_desktop_config.json",
                  "/home/u/ünï/.codex/config.toml", "/home/u/.GEMINI/Settings.JSON"):
            with self.subTest(path=p):
                self.assertTrue(mcp.is_mcp_config_path(p))
        for p in ("/home/u/My Projects/mcp.json.bak", "/home/u/mcp .json", "/home/u/.codex/ config.toml", "/home/u/.mcp.json/x.txt"):
            with self.subTest(path=p):
                self.assertFalse(mcp.is_mcp_config_path(p))

    def test_windows_style_paths(self):
        for p in ("C:\\Users\\Ana María\\.claude.json", "C:\\Users\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
                  "C:/Users/u/.codex/config.toml", "C:\\Users\\u\\.codex\\config.toml", "\\\\server\\share\\My Files\\.mcp.json",
                  "D:\\work\\.GEMINI\\SETTINGS.JSON", "mixed/dir\\sub\\mcp.json"):
            with self.subTest(path=p):
                self.assertTrue(mcp.is_mcp_config_path(p))
        for p in ("C:\\Users\\u\\settings.json", "C:\\Users\\u\\.codex\\other.toml", "C:\\", "\\", "", "C:\\mcp.json\\"):
            with self.subTest(path=p):
                self.assertFalse(mcp.is_mcp_config_path(p))

    def test_the_login_key_is_ignored_only_in_claude_json_with_any_style_of_path(self):
        text = '{"primaryApiKey": "%s"}' % FAKE
        for p in ("C:\\Users\\Ana María\\.claude.json", "/home/u/ünï dir/.claude.json", ".claude.json"):
            with self.subTest(path=p):
                self.assertEqual(mcp.find_mcp_config_secrets(text, p), [])
                spans = mcp.find_mcp_config_secret_spans(text, p)
                self.assertEqual([s.get("silent") for s in spans], [True])
        self.assertEqual(len(mcp.find_mcp_config_secrets(text, "/home/u/other.json")), 1)

    def test_unicode_values_and_names_keep_offsets_right(self):
        text = '{"nombre": "ñandú 日本", "A_API_KEY": "%s"}' % FAKE
        (sp,) = mcp.find_mcp_config_secret_spans(text)
        self.assertEqual(text[int(sp["start"]):int(sp["end"])], FAKE)

    def test_crlf_line_endings(self):
        text = '{\r\n"A_TOKEN": "%s",\r\n"B_TOKEN": "%s"\r\n}' % (FAKE, FAKE)
        self.assertEqual([g[0] for g in _kinds(text)], [2, 3])
        for sp in mcp.find_mcp_config_secret_spans(text):
            self.assertEqual(text[int(sp["start"]):int(sp["end"])], FAKE)

    def test_the_name_is_made_safe_for_output(self):
        (f,) = mcp.find_mcp_config_secrets('{"A TOKEN\u202e/../x_token": "%s"}' % FAKE)
        self.assertRegex(str(f["name"]), r"^[A-Za-z0-9_.-]+$")


def _node_or_skip() -> str:
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed: skipping the Node.js/Python MCP secrets parity check")
    if not NODE_LIB.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the MCP secrets parity check")
    return node


def _run_node(cases):
    node = _node_or_skip()
    with tempfile.TemporaryDirectory() as empty:
        r = subprocess.run([node, "-e", _NODE_RUNNER, str(NODE_LIB)], input=json.dumps({"cases": cases}),
                           capture_output=True, text=True, encoding="utf-8", cwd=empty, timeout=120)
    if r.returncode != 0:
        raise AssertionError("node failed: " + r.stderr[:500])
    return json.loads(r.stdout)


def _parity_corpus() -> List[Dict[str, Any]]:
    v = FAKE
    texts = {
        "claude json": '{"mcpServers": {"s": {"command": "npx", "args": ["-y", "p@1", "--api-key", "%s"], "env": {"BRAVE_API_KEY": "%s", "LOG": "debug"}}, "r": {"url": "https://m.example.com/sse?api_key=%s", "headers": {"Authorization": "Bearer %s"}}}}' % (v, v, v, v),
        "pretty json": '{\n  "mcpServers": {\n    "a": {\n      "env": {\n        "A_API_KEY": "%s",\n        "B_TOKEN": "${B_TOKEN}"\n      }\n    }\n  }\n}\n' % v,
        "json with comments": '{\n // c\n "A_API_KEY": "%s", /* c */ "B": 1\n}\n' % v,
        "toml": '[mcp_servers.a]\ncommand = "x"\nenv = { A_API_KEY = "%s" }\n[mcp_servers.a.http_headers]\nAuthorization = "Bearer %s"\n' % (v, v),
        "cut off json": '{ "env": { "A_API_KEY": "%s",' % v,
        "broken toml": '[a\nB_TOKEN = "%s" ===\n[[x\n' % v,
        "references": '{"A_TOKEN": "__ZN_A_TOKEN__", "B_TOKEN": "${B}", "C_TOKEN": "$C", "D_TOKEN": "%D%", "E_TOKEN": "{env:E}", "F_TOKEN": "<f>"}',
        "marker inside value": '{"A_TOKEN": "x-__ZN_X__-%s"}' % v,
        "flag pairs": '{"args": ["--token", "%s", "--password=%s", "-p", "%s", "--header=Authorization: Bearer %s", "X-Api-Key: %s"]}' % (v, v, v, v, v),
        "flag over comment": '{"args": [\n"--api-key",\n// c\n"%s"\n]}' % v,
        "flag then flag": '{"args": ["--token", "--other", "%s"]}' % v,
        "url params": '{"u": "https://h.example.com/m?a=1&token=%s&sig=%s#key=%s", "p": "/not/a/url?token=%s"}' % (v, v, v, v),
        "not credentials": '{"A_TOKEN": "true", "B_PASSWORD": "short", "public_key": "%s", "ssh_key": "%s", "sort_key": "%s", "key": "%s"}' % (v, v, v, v),
        "login key": '{"primaryApiKey": "%s"}' % v,
        "crlf": '{\r\n"A_TOKEN": "%s"\r\n}' % v,
        "unicode": '{"ñandú": "日本", "A_API_KEY": "%s", "名前": "%s"}' % (v, v),
        "camel names": '{"apiKey": "%s", "accessToken": "%s", "clientSecret": "%s", "X-Api-Key": "%s"}' % (v, v, v, v),
        "scheme values": '{"h": "Bearer %s", "t": "Basic %s", "s": "Bearer of bad news and more words"}' % (v, v),
        "garbage": "\x00{ \"A_TOKEN\": \" '\"=:=: [[[ ",
        "unterminated": '{ "x": "abc\n"A_API_KEY": "%s" }' % v,
        "empty": "",
        "single quotes": "{'A_API_KEY': '%s', 'args': ['--token', '%s']}" % (v, v),
        "empty value and equals": '{"A_TOKEN": "", "B_TOKEN" == "%s", "C_TOKEN": = "%s"}' % (v, v),
        "long bare word": "a" * 200 + ' = "%s"' % v,
        "long arg": '{"args": ["--token=' + "x" * 5000 + '"]}',
    }
    files = ["", ".claude.json", "C:\\Users\\Ana María\\.claude.json", "/home/u/My Dir/.mcp.json", "/home/u/日本/.codex/config.toml"]
    cases = [{"name": n, "text": t, "file": f} for n, t in texts.items() for f in files]
    paths = [{"name": "path " + p, "text": "", "file": p} for p in (
        "C:\\Users\\Ana María\\.claude.json", "//srv/share/.mcp.json", "x\\.codex\\config.toml", "a/b/.GEMINI/SETTINGS.JSON",
        "mcp.json.bak", "", ".codex/config.json", "\\\\.\\mcp.json", "dir/mcp.json/", "ünï/opencode.JSONC")]
    return cases + paths


class TestNodeParity(unittest.TestCase):
    def test_python_and_node_give_the_same_results_on_the_same_configs(self):
        cases = _parity_corpus()
        node = _run_node([{"text": c["text"], "file": c["file"]} for c in cases])
        self.assertEqual(len(node), len(cases))
        for c, n in zip(cases, node, strict=True):
            with self.subTest(case=c["name"], file=c["file"]):
                spans = mcp.find_mcp_config_secret_spans(c["text"], c["file"])
                self.assertEqual(spans, n["spans"])
                self.assertEqual(mcp.find_mcp_config_secrets(c["text"], c["file"]), n["findings"])
                self.assertEqual(mcp.mask_mcp_values(c["text"], spans), n["masked"])
                self.assertEqual(mcp.is_mcp_config_path(c["file"]), n["isConfig"])

    def test_the_corpus_is_not_one_where_both_sides_find_nothing(self):
        total = sum(len(mcp.find_mcp_config_secret_spans(c["text"], c["file"])) for c in _parity_corpus())
        self.assertGreater(total, 60)

    def test_helper_functions_agree(self):
        node = _node_or_skip()
        names = ["apiKey", "X-Api-Key", "BRAVE_API_KEY", "githubPersonalAccessToken", "ñandú_token", "public_key", "", "___",
                 "a.b-c d", "primaryApiKey", "SSH_KEY", "key", "Authorization", "PGPASSWORD", "my-pwd", "pat", "x"]
        out = subprocess.run([node, "-e", _NODE_HELPERS, str(NODE_LIB), json.dumps(names)], capture_output=True, text=True,
                             encoding="utf-8", timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr[:300])
        for name, got in zip(names, json.loads(out.stdout), strict=True):
            with self.subTest(name=name):
                norm = mcp.normalize_name(name)
                self.assertEqual(got, [norm, mcp.is_secret_name(norm), mcp.suggested_name(norm),
                                       mcp.mcp_next_step("environment variable", name), mcp.mcp_next_step("header", name),
                                       mcp.mcp_sample("argument", name), mcp.mcp_sample("URL", name), mcp.mcp_sample("header", name)])


class TestSharedFixtureParity(unittest.TestCase):
    """The shared fixture (lines, file, paths) gives the same results in Python and Node."""

    def test_shared_fixture_cases_match_node_spans_findings_and_masking(self):
        cases = json.loads(SHARED_FIXTURE.read_text(encoding="utf-8"))["cases"]
        texts = [("\n".join(c["lines"]).replace("{V}", FAKE), c.get("file", "")) for c in cases]
        node = _run_node([{"text": t, "file": f} for t, f in texts])
        self.assertEqual(len(node), len(texts))
        for (text, file), (c, n) in zip(texts, zip(cases, node, strict=True), strict=True):
            with self.subTest(case=c["name"]):
                spans = mcp.find_mcp_config_secret_spans(text, file)
                self.assertEqual(spans, n["spans"])
                self.assertEqual(mcp.find_mcp_config_secrets(text, file), n["findings"])
                self.assertEqual(mcp.mask_mcp_values(text, spans), n["masked"])

    def test_shared_fixture_paths_match_node(self):
        paths = json.loads(SHARED_FIXTURE.read_text(encoding="utf-8"))["paths"]
        node = _run_node([{"text": "", "file": p["path"]} for p in paths])
        for p, n in zip(paths, node, strict=True):
            with self.subTest(path=p["path"]):
                self.assertEqual(mcp.is_mcp_config_path(p["path"]), p["mcp"])
                self.assertEqual(n["isConfig"], p["mcp"])

    def test_windows_and_posix_shapes_built_with_ntpath_and_posixpath(self):
        home = ntpath.join("C:\\Users\\Ana María", ".claude.json")
        text = '{"primaryApiKey": "%s", "BRAVE_API_KEY": "%s"}' % (FAKE, FAKE)
        self.assertEqual([f["name"] for f in mcp.find_mcp_config_secrets(text, home)], ["BRAVE_API_KEY"])
        self.assertTrue(mcp.is_mcp_config_path(ntpath.join("D:\\work", ".gemini", "settings.json")))
        self.assertFalse(mcp.is_mcp_config_path(ntpath.join("C:\\Users\\u", "mcp.json.bak")))
        self.assertTrue(mcp.is_mcp_config_path(posixpath.join("/home/u", "proyecto ñandú", ".mcp.json")))
        self.assertFalse(mcp.is_mcp_config_path(posixpath.join("/home/u", "My Dir", "mcp.json.bak")))

    def test_empty_and_broken_inputs_match_node(self):
        texts = ["", "\n\n", "{", "}", '"', "=", "{ /* unterminated\n  \"BRAVE_API_KEY\": \"%s\"\n}" % FAKE,
                 '{"s": {"env": {}, "headers": null, "args": []}}', '{"args": ["--api-key"]}']
        node = _run_node([{"text": t, "file": ""} for t in texts])
        for t, n in zip(texts, node, strict=True):
            with self.subTest(text=t[:20]):
                self.assertEqual(mcp.find_mcp_config_secrets(t), n["findings"])
                self.assertEqual(mcp.mask_mcp_values(t, mcp.find_mcp_config_secret_spans(t)), n["masked"])

    def test_offsets_after_an_astral_character_match_node(self):
        # Both engines report offsets in UTF-16 code units: an emoji before a credential on the
        # same line counts as two, in Python too, and masking gives the same text.
        text = '{"\U0001F4C1": "x", "BRAVE_API_KEY": "%s"}' % FAKE
        node = _run_node([{"text": text, "file": ""}])[0]
        spans = mcp.find_mcp_config_secret_spans(text)
        self.assertEqual(spans, node["spans"])
        self.assertEqual(mcp.mask_mcp_values(text, spans), node["masked"])


class TestNestedSecretValues(unittest.TestCase):
    def test_credential_nested_under_a_secret_named_object_is_reported(self):
        text = '{"API_TOKEN": {"value": "%s"}}' % FAKE
        self.assertEqual(_kinds(text), [(1, "environment variable", "API_TOKEN")])
        text = '{"env": {"DB_PASSWORD": {"default": "%s"}}}' % FAKE
        self.assertEqual(_kinds(text), [(1, "environment variable", "DB_PASSWORD")])

    def test_nested_value_is_found_across_lines_and_masked(self):
        text = '{\n "apiKey": {\n  "type": "string",\n  "value": "%s"\n },\n "other": {"value": "%s"}\n}' % (FAKE, FAKE)
        self.assertEqual(_kinds(text), [(4, "setting", "apiKey")])
        out = mcp.mask_mcp_values(text, mcp.find_mcp_config_secret_spans(text))
        self.assertEqual(out.count(FAKE), 1)

    def test_array_items_under_a_secret_named_key_are_reported(self):
        text = '{"A_TOKEN": ["%s"], "B_TOKEN": ["--x", "%s"]}' % (FAKE, FAKE)
        self.assertEqual([g[2] for g in _kinds(text)], ["A_TOKEN", "B_TOKEN"])

    def test_references_placeholders_and_empty_nested_values_are_not_reported(self):
        for v in ("${API_TOKEN}", "<key>", "YOUR_KEY", "__ZN_API_TOKEN__", "$API_TOKEN", "", "true"):
            with self.subTest(value=v):
                self.assertEqual(_kinds('{"API_TOKEN": {"value": "%s", "default": "%s"}}' % (v, v)), [])

    def test_other_keys_and_other_objects_are_not_reported(self):
        self.assertEqual(_kinds('{"auth": {"client_id": "%s", "type": "oauth"}}' % FAKE), [])
        self.assertEqual(_kinds('{"API_TOKEN": {"description": "%s"}}' % FAKE), [])
        self.assertEqual(_kinds('{"API_TOKEN": {"a": {"b": ["%s"]}}, "LOG": {"value": "%s"}}' % (FAKE, FAKE)), [])

    def test_nesting_is_bounded_and_broken_input_does_not_raise(self):
        deep = '{"API_TOKEN": ' + '{"x": ' * 10 + '{"value": "%s"}' % FAKE + "}" * 11
        self.assertEqual(_kinds(deep), [])
        for text in ('{"API_TOKEN": {"value": ', '{"API_TOKEN": [[[[[[[[[[["%s"' % FAKE,
                     '"API_TOKEN": {' + "\n" * 300 + '"value": "%s"' % FAKE):
            mcp.find_mcp_config_secrets(text)

    def test_toml_inline_table(self):
        text = 'env = { API_TOKEN = { value = "%s" } }' % FAKE
        self.assertEqual(_kinds(text), [(1, "environment variable", "API_TOKEN")])


if __name__ == "__main__":
    unittest.main()
