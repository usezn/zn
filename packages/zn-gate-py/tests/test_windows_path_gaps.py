"""Windows spellings of protected paths and destructive targets, on the table shared with the Node.js package.

The table lives in packages/zn-gate/test/fixtures/windows_path_gap_cases.json; the test is skipped when that package is
not next to this one (an sdist). Strings only: nothing is read from disk or run. An entry with a gap id names a spelling
that Windows resolves to a protected target but the rules do not catch yet; those tests are skipped unless
ZN_RUN_GAP_TESTS=1 is set. Remove the skip for a gap when it is fixed.
"""

import json
import os
import unittest
from collections import defaultdict
from pathlib import Path

from zn_gate import check_tool_call
from zn_gate.destructive import check_command

CASES_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "windows_path_gap_cases.json"
RUN_GAPS = os.environ.get("ZN_RUN_GAP_TESTS") == "1"


def _table():
    if not CASES_FILE.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package")
    return json.loads(CASES_FILE.read_text(encoding="utf-8"))


def _group(rows, key):
    by = defaultdict(list)
    for r in rows:
        by[r["id"]].append(r[key])
    return by


def _path_misses(p):
    out = []
    for tool, args in (("read_file", {"path": p}), ("shell", {"command": 'cat "' + p + '"'}), ("shell", {"command": "type " + p})):
        res = check_tool_call(tool, args)
        if res.rule != "path:sensitive_file":
            out.append("%s %r -> %s (%s)" % (tool, args, res.verdict, res.rule))
    return out


class TestWindowsPathSpellings(unittest.TestCase):
    def _check_text(self, gap):
        missed = []
        for p in _group(_table()["text"], "path").get(gap, []):
            missed.extend(_path_misses(p))
        self.assertEqual(missed, [])

    def _check_destructive(self, gap):
        cmds = _group(_table()["destructive"], "command").get(gap, [])
        self.assertTrue(cmds)
        self.assertEqual([c for c in cmds if check_command(c).verdict != "block"], [])

    def test_path_rule_blocks_current_spellings(self):
        self._check_text("ok")

    def test_path_rule_leaves_devices_and_templates_alone(self):
        for p in _table()["text_allowed"]:
            for tool, args in (("read_file", {"path": p}), ("shell", {"command": 'cat "' + p + '"'})):
                with self.subTest(tool=tool, path=p):
                    self.assertNotEqual(check_tool_call(tool, args).rule, "path:sensitive_file")

    def test_destructive_blocks_current_spellings(self):
        self._check_destructive("ok")

    def test_destructive_leaves_build_folder_and_null_device_alone(self):
        for c in _table()["destructive_allowed"]:
            with self.subTest(command=c):
                self.assertEqual(check_command(c).verdict, "allow")

    @unittest.skipUnless(RUN_GAPS, "open gap WP1-drive-relative")
    def test_WP1_drive_relative(self):
        self._check_text("WP1-drive-relative")

    @unittest.skipUnless(RUN_GAPS, "open gap WP2-short-name")
    def test_WP2_short_name(self):
        self._check_text("WP2-short-name")

    @unittest.skipUnless(RUN_GAPS, "open gap WP3-folder-stream-or-space")
    def test_WP3_folder_stream_or_space(self):
        self._check_text("WP3-folder-stream-or-space")

    @unittest.skipUnless(RUN_GAPS, "open gap WD1-trailing-dot-or-space")
    def test_WD1_trailing_dot_or_space(self):
        self._check_destructive("WD1-trailing-dot-or-space")

    @unittest.skipUnless(RUN_GAPS, "open gap WD2-extended-prefix")
    def test_WD2_extended_prefix(self):
        self._check_destructive("WD2-extended-prefix")

    @unittest.skipUnless(RUN_GAPS, "open gap WD3-admin-share")
    def test_WD3_admin_share(self):
        self._check_destructive("WD3-admin-share")

    @unittest.skipUnless(RUN_GAPS, "open gap WD4-short-name")
    def test_WD4_short_name(self):
        self._check_destructive("WD4-short-name")

    @unittest.skipUnless(RUN_GAPS, "open gap WD5-drive-less")
    def test_WD5_drive_less(self):
        self._check_destructive("WD5-drive-less")

    @unittest.skipUnless(RUN_GAPS, "open gap WD6-folder-stream")
    def test_WD6_folder_stream(self):
        self._check_destructive("WD6-folder-stream")

    @unittest.skipUnless(RUN_GAPS, "open gap WD7-variable-spelling")
    def test_WD7_variable_spelling(self):
        self._check_destructive("WD7-variable-spelling")


if __name__ == "__main__":
    unittest.main()
