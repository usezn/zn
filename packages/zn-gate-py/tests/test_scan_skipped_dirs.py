"""The scan reports the directories it does not enter and reads `target` without a build file."""
import argparse
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout

from zn_gate import cli
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


class PythonScanDirsTests(unittest.TestCase):
    def test_test_dirs_are_read_and_vendor_follows_the_manifest_rule(self):
        d = _tree({"tests/f.md": "hello\n", "__tests__/f.md": "hello\n", "test/f.md": "hello\n",
                   "plain/vendor/n.md": "hello\n", "go/go.mod": "module x\n", "go/vendor/dep.md": "hello\n",
                   ".idea/x.md": "hello\n", ".turbo/x.md": "hello\n"})
        try:
            data = json.loads(_run(d))
            self.assertEqual(data["total_files"], 4)  # three test files and plain/vendor/n.md
            self.assertEqual(len(data["skipped_dirs"]), 1)
            self.assertEqual(data["skipped_dirs"][0]["reason"], "skipped by name: dependencies next to go.mod")
        finally:
            shutil.rmtree(d, ignore_errors=True)


_NODE = shutil.which("node")
_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_PRUNE_JS = os.path.join(_REPO, "packages", "zn-gate", "lib", "prune.js")
_CLI_JS = os.path.join(_REPO, "packages", "zn-gate", "bin", "cli.js")


@unittest.skipUnless(_NODE and os.path.exists(_PRUNE_JS), "needs node and the Node package in the repo")
class NodePythonPruneParityTests(unittest.TestCase):
    def test_lists_and_markers_match(self):
        code = ("const p=require(process.argv[1]);"
                "console.log(JSON.stringify({scan:[...p.SCAN_DIRS].sort(),"
                "silent:[...p.SILENT].filter(n=>p.SCAN_DIRS.has(n)).sort(),markers:p.MARKERS}))")
        r = subprocess.run([_NODE, "-e", code, _PRUNE_JS], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        node = json.loads(r.stdout)
        self.assertEqual(sorted(cli._SCAN_SKIP_DIRS), node["scan"])
        self.assertEqual(sorted(cli._SILENT_SKIP_DIRS), node["silent"])
        self.assertEqual({k: list(v) for k, v in cli._SKIP_MARKERS.items()}, node["markers"])

    def test_same_tree_gives_the_same_report(self):
        names = ["node_modules", ".git", ".next", ".turbo", ".idea", ".venv", "venv", "__pycache__", ".eggs",
                 "dist", "build", "test", "tests", "__tests__", "out", "coverage"]
        files = {n + "/f.md": "hello\n" for n in names}
        files.update({"plain/target/f.md": "hello\n", "plain/vendor/f.md": "hello\n", "rust/Cargo.toml": "[package]\n",
                      "rust/target/f.md": "hello\n", "rust/vendor/f.md": "hello\n", "go/go.mod": "module x\n",
                      "go/vendor/f.md": "hello\n", "mvn/pom.xml": "<project/>\n", "mvn/target/f.md": "hello\n"})
        d = _tree(files)
        try:
            py = json.loads(_run(d))
            r = subprocess.run([_NODE, _CLI_JS, "scan", d, "--format", "json"], capture_output=True, text=True,
                               timeout=120, env={**os.environ, "ZN_LOCAL_ONLY": "true"})
            node = json.loads(r.stdout)

            def rel(report):
                return sorted((os.path.relpath(s["dir"], d).replace("\\", "/"), s["reason"]) for s in report["skipped_dirs"])

            self.assertEqual(rel(py), rel(node))
            self.assertEqual(py["total_files"], node["total_files"])
            self.assertTrue(rel(py))
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
