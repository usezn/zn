"""An unusable home folder (unset with no passwd entry, empty, relative, "/") never moves state into the current
folder or the disk root: nothing is written and the message names HOME and ZN_HOME. An absolute ZN_HOME rescues
each case. Every case runs in a child process with a clean, empty working folder."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SRC = str(Path(__file__).resolve().parents[1] / "src")

# A uid with no passwd entry: the lookup of the account's home fails, as in a container run as an unknown uid.
PRELUDE = (
    "import pwd\n"
    "def _nopw(*a, **k):\n"
    "    raise KeyError('no passwd entry')\n"
    "pwd.getpwuid = _nopw\n"
    "pwd.getpwnam = _nopw\n"
)

LOG = PRELUDE + (
    "import json, sys\n"
    "from zn_gate import log_evidence\n"
    "r = log_evidence({'agent': 't', 'payload': 'x', 'verdict': 'allow'})\n"
    "print('LOGGED' if r else 'NOT_LOGGED')\n"
)
CLI = PRELUDE + "import sys\nfrom zn_gate.cli import main\nsys.argv = ['zn-gate'] + sys.argv[1:]\nsys.exit(main())\n"

CASES = {
    "no home and no passwd entry": {},
    "empty HOME": {"HOME": "", "USERPROFILE": ""},
    "relative HOME": {"HOME": "relhome", "USERPROFILE": "relhome"},
    "HOME is the root folder": {"HOME": "/", "USERPROFILE": "/"},
}
if os.name == "nt":
    del CASES["HOME is the root folder"]


def run(code, env, cwd, *args):
    base = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": SRC}
    if os.name == "nt":
        base["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "")
    base.update(env)
    return subprocess.run([sys.executable, "-c", code, *args], cwd=cwd, env=base, capture_output=True, text=True)


class TestHomeResolutionSafe(unittest.TestCase):
    def work(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        return d.name

    def test_log_evidence_writes_nothing_and_names_the_variables(self):
        for name, env in CASES.items():
            with self.subTest(name):
                cwd = self.work()
                r = run(LOG, env, cwd)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("NOT_LOGGED", r.stdout)
                self.assertIn("ZN_HOME", r.stderr)
                self.assertIn("HOME", r.stderr)
                self.assertEqual(os.listdir(cwd), [], name)

    def test_cli_commands_stop_with_a_clear_message(self):
        for name, env in CASES.items():
            for args in (["stats"], ["evidence"]):
                with self.subTest(name + " " + " ".join(args)):
                    cwd = self.work()
                    r = run(CLI, env, cwd, *args)
                    self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                    self.assertIn("ZN_HOME", r.stderr)
                    self.assertNotIn("Traceback", r.stderr)
                    self.assertEqual(os.listdir(cwd), [], name)

    def test_absolute_zn_home_makes_it_work_and_state_goes_there_only(self):
        for name, env in CASES.items():
            with self.subTest(name):
                cwd = self.work()
                zn = os.path.join(self.work(), "state")
                r = run(LOG, {**env, "ZN_HOME": zn}, cwd)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("LOGGED", r.stdout.replace("NOT_LOGGED", ""))
                self.assertTrue(os.path.exists(os.path.join(zn, "evidence.jsonl")))
                self.assertEqual(os.listdir(cwd), [], name)

    def test_no_folder_named_tilde_is_created(self):
        cwd = self.work()
        run(LOG, {}, cwd)
        self.assertFalse(os.path.exists(os.path.join(cwd, "~")))

    def test_version_and_help_do_not_need_a_home(self):
        cwd = self.work()
        r = run(CLI, {}, cwd, "version")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(os.listdir(cwd), [])

    def test_the_rule_in_process(self):
        from zn_gate import home
        saved = dict(os.environ)
        try:
            os.environ.pop("ZN_HOME", None)
            os.environ["HOME"] = os.environ["USERPROFILE"] = tempfile.gettempdir()
            self.assertEqual(home.zn_home(), os.path.join(tempfile.gettempdir(), ".zn"))
            os.environ["ZN_HOME"] = os.path.join(tempfile.gettempdir(), "z")
            self.assertEqual(home.zn_home(), os.path.join(tempfile.gettempdir(), "z"))
        finally:
            os.environ.clear()
            os.environ.update(saved)


if __name__ == "__main__":
    unittest.main()
