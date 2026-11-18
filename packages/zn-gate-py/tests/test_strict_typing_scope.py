"""The CI job that runs `mypy --strict` on the public API names every module behind `zn_gate.__all__`.

A name added to the package `__init__` from a new module must be added to that job, or its signature is never
checked in strict mode.
"""
import re
import unittest
from pathlib import Path

import zn_gate

CI = Path(__file__).resolve().parents[3] / ".github" / "workflows" / "ci.yml"


@unittest.skipUnless(CI.is_file(), "workflow file is not part of this checkout")
class TestStrictTypingScope(unittest.TestCase):
    def strict_files(self):
        text = CI.read_text(encoding="utf-8")
        m = re.search(r"python -m mypy --strict\s+(.*?)\n\s*- name:", text, re.S)
        self.assertIsNotNone(m, "the strict mypy step is missing from ci.yml")
        return set(m.group(1).split())

    def test_every_module_behind_the_exports_is_checked_in_strict_mode(self):
        files = self.strict_files()
        modules = {"rules"} | set(zn_gate._LAZY.values())
        for module in sorted(modules):
            self.assertIn("src/zn_gate/%s.py" % module, files, "%s is exported but not checked with --strict" % module)

    def test_type_level_assertions_file_is_part_of_the_job(self):
        self.assertIn("typing_check/check_public_api.py", self.strict_files())

    def test_every_lazy_name_is_exported(self):
        self.assertTrue(set(zn_gate._LAZY) <= set(zn_gate.__all__))
