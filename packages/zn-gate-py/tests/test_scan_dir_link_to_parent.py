"""A folder link that points back to its parent does not make the scan hang."""

import contextlib
import io
import json
import os
import shutil
import tempfile
import threading
import unittest
from argparse import Namespace
from pathlib import Path

from zn_gate.cli import cmd_scan


def _scan(path):
    out = io.StringIO()
    args = Namespace(path=str(path), format="json", exclude=None, include=None, include_home=False, no_fail=False, code=False)
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        cmd_scan(args)
    return out.getvalue()


class DirLinkToParent(unittest.TestCase):
    def setUp(self):
        self.base = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)

    def test_folder_link_to_its_parent_returns(self):
        Path(self.base, "notes.md").write_text("# notes\n", encoding="utf-8")
        try:
            os.symlink(self.base, os.path.join(self.base, "loop"), target_is_directory=True)
        except (OSError, NotImplementedError) as e:
            self.skipTest(f"cannot create a symbolic link here ({e})")
        result = {}

        def run():
            try:
                result["out"] = _scan(self.base)
            except BaseException as e:  # reported below on the main thread
                result["error"] = e

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(10)
        self.assertFalse(worker.is_alive(), "scan did not return within 10 s")
        if "error" in result:
            raise result["error"]
        # The link is listed but not entered, so the one real file is counted once.
        self.assertEqual(json.loads(result["out"])["total_files"], 1)


if __name__ == "__main__":
    unittest.main()
