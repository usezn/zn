"""The Promptfoo example: the provider id in the config points at a file Promptfoo can load, and every test case in
the config gets the verdict it expects from that provider.

Promptfoo loads `python:<file>:<function>` from a file path, not from a module name, so
`python:zn_gate.integrations.promptfoo:call_api` fails with "Cannot load module" in current Promptfoo releases.
"""
import ast
import importlib.util
import json
import re
import unittest
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "promptfoo"
CONFIG = EXAMPLE / "promptfooconfig.yaml"


def scalar(text):
    """A YAML single- or double-quoted scalar, as the example uses them (double quotes allow \\u escapes)."""
    text = text.strip()
    if text.startswith('"'):
        return json.loads(text)
    return text[1:-1].replace("''", "'")


def cases(text):
    out = []
    for block in re.split(r"\n  - vars:\n", text.split("\ntests:\n", 1)[1])[1:]:
        query = re.search(r"^      query: (.+)$", block, re.M)
        expected = [scalar(m.group(1)) for m in re.finditer(r"^        value: (.+)$", block, re.M)]
        out.append((scalar(query.group(1)), expected))
    return out


@unittest.skipUnless(CONFIG.is_file(), "examples folder is not part of this checkout")
class TestPromptfooExample(unittest.TestCase):
    def test_provider_id_names_a_file_next_to_the_config(self):
        text = CONFIG.read_text(encoding="utf-8")
        ids = re.findall(r"^\s+- id: '(python:[^']+)'", text, re.M)
        self.assertEqual(ids, ["python:zn_provider.py:call_api"])
        path, func = ids[0][len("python:"):].rsplit(":", 1)
        self.assertTrue((EXAMPLE / path).is_file(), path)
        spec = importlib.util.spec_from_file_location("zn_provider_example", EXAMPLE / path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertTrue(callable(getattr(module, func)))

    def test_provider_file_is_one_import(self):
        tree = ast.parse((EXAMPLE / "zn_provider.py").read_text(encoding="utf-8"))
        imports = [n for n in tree.body if isinstance(n, ast.ImportFrom)]
        self.assertEqual([(n.module, [a.name for a in n.names]) for n in imports],
                         [("zn_gate.integrations", ["call_api"])])

    def test_every_case_in_the_config_gets_the_expected_verdict(self):
        from zn_gate.integrations import call_api

        found = cases(CONFIG.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(found), 6)
        for query, expected in found:
            result = call_api(query, {}, {})
            for value in expected:
                self.assertIn(value, result["output"], "query %r" % query)

    def test_the_homoglyph_case_carries_a_real_cyrillic_letter(self):
        # In a single-quoted YAML string "\\u0435" stays four plain characters and the case tests nothing.
        queries = [q for q, _ in cases(CONFIG.read_text(encoding="utf-8"))]
        self.assertTrue(any("е" in q for q in queries))
        self.assertFalse(any("\\u" in q for q in queries))
