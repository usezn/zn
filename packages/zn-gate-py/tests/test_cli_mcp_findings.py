"""The findings the CLI builds from MCP credential spans. The spans are invented
dicts; no file is read and no value appears in a finding."""

import unittest

from zn_gate import mcp_secrets as mcp
from zn_gate.cli import _mcp_violations

KEYS = {"file", "line", "rule", "reason", "type", "content", "next_step"}


def _span(kind, name, line, **extra):
    span = {"kind": kind, "name": name, "line": line, "start": 0, "end": 1}
    span.update(extra)
    return span


class McpViolationsTests(unittest.TestCase):
    def test_no_spans_give_no_findings(self):
        self.assertEqual(_mcp_violations("mcp.json", []), [])

    def test_silent_span_is_skipped(self):
        found = [_span("header", "X-Api-Key", 3, silent=True)]
        self.assertEqual(_mcp_violations("mcp.json", found), [])

    def test_silent_span_between_others_leaves_two_findings(self):
        found = [
            _span("header", "X-Api-Key", 2),
            _span("argument", "--token", 4, silent=True),
            _span("URL", "key", 6),
        ]
        out = _mcp_violations("mcp.json", found)
        self.assertEqual([f["line"] for f in out], [2, 6])

    def test_two_spans_give_two_findings_in_order(self):
        found = [_span("header", "X-Api-Key", 9), _span("argument", "--token", 5)]
        out = _mcp_violations("conf/mcp.json", found)
        self.assertEqual(len(out), 2)
        self.assertEqual([f["line"] for f in out], [9, 5])
        self.assertIn("X-Api-Key", out[0]["content"])
        self.assertIn("--token", out[1]["content"])

    def test_finding_fields(self):
        found = [_span("URL", "api_key", 7)]
        (f,) = _mcp_violations("example/mcp.json", found)
        self.assertEqual(set(f), KEYS)
        self.assertEqual(f["file"], "example/mcp.json")
        self.assertEqual(f["line"], 7)
        self.assertEqual(f["rule"], mcp.RULE_ID)
        self.assertEqual(f["reason"], mcp.mcp_reason("URL"))
        self.assertEqual(f["type"], "secret_leak")
        self.assertEqual(f["content"], mcp.mcp_sample("URL", "api_key"))
        self.assertEqual(f["next_step"], mcp.mcp_next_step("URL", "api_key"))
        self.assertIn("[REDACTED]", f["content"])


if __name__ == "__main__":
    unittest.main()
