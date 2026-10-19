"""The scan reports the directories it does not enter and reads `target` without a build file."""
import argparse
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

from zn_gate.cli import cmd_scan


def _tree(files):
    d = tempfile.mkdtemp()
    for rel, text in files.items():
        p = os.path.join(d, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
    return d


def _run(path, fmt="json", exclude=None):
    buf = io.StringIO()
    with redirect_stdout(buf):
        cmd_scan(argparse.Namespace(path=path, exclude=exclude, include=None, format=fmt, no_fail=False))
    return buf.getvalue()


class SkippedDirsTests(unittest.TestCase):
    def test_pruned_directories_are_listed_and_caches_are_not(self):
        d = _tree({"ok.md": "hello\n", "build/p.md": "hello\n", "dist/p.md": "hello\n",
                   "node_modules/x/r.md": "hello\n", ".venv/r.md": "hello\n"})
        try:
            data = json.loads(_run(d))
            self.assertEqual(data["total_files"], 1)
            self.assertEqual(sorted(os.path.basename(s["dir"]) for s in data["skipped_dirs"]), ["build", "dist"])
            self.assertEqual(data["total_skipped_dirs"], 2)
            self.assertIn("skipped by name", data["skipped_dirs"][0]["reason"])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_target_is_read_without_a_build_file_and_skipped_with_one(self):
        d = _tree({"plain/target/fixture.md": "hello\n", "rust/Cargo.toml": "[package]\n",
                   "rust/target/out.md": "hello\n"})
        try:
            data = json.loads(_run(d))
            self.assertEqual(data["total_files"], 2)  # fixture.md and Cargo.toml
            self.assertEqual(len(data["skipped_dirs"]), 1)
            self.assertTrue(data["skipped_dirs"][0]["dir"].replace("\\", "/").endswith("rust/target"))
            self.assertIn("next to Cargo.toml", data["skipped_dirs"][0]["reason"])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_exclude_is_quiet_and_text_github_show_counts(self):
        d = _tree({"ok.md": "hello\n", "mine/a.md": "hello\n", "dist/b.md": "hello\n"})
        try:
            data = json.loads(_run(d, exclude="mine"))
            self.assertEqual([os.path.basename(s["dir"]) for s in data["skipped_dirs"]], ["dist"])
            self.assertEqual(data["total_files"], 1)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_text_and_github_show_the_directory_report(self):
        d = _tree({"ok.md": "hello\n", "dist/b.md": "hello\n"})
        try:
            self.assertIn("Directories not scanned (1):", _run(d, "text"))
            gh = _run(d, "github")
            self.assertIn("title=Directory not scanned::", gh)
            self.assertIn("(0 not scanned and 1 directory skipped)", gh)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_the_directory_you_pass_is_always_read(self):
        d = _tree({"build/p.md": "hello\n"})
        try:
            data = json.loads(_run(os.path.join(d, "build")))
            self.assertEqual(data["total_files"], 1)
            self.assertEqual(data["total_skipped_dirs"], 0)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
