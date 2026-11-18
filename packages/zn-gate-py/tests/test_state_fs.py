"""The state folder probe and the warning in `zn-gate check` (same behaviour as the npm package)."""
import errno
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from zn_gate import cli, state_fs


class FakeLayer:
    def __init__(self, mode=0o600, bind=None, dirs=None, create_error=None):
        self.mode, self.bind, self.dirs, self.create_error = mode, bind, dirs, create_error
        self.created, self.unlinked, self.bound, self.chmods = [], [], [], []

    def is_dir(self, path):
        return True if self.dirs is None else path in self.dirs

    def create(self, path):
        if self.create_error:
            raise OSError(self.create_error, "x")
        self.created.append(path)

    def chmod(self, path, mode):
        self.chmods.append((path, mode))

    def mode_of(self, path):
        return self.mode

    def unlink(self, path):
        self.unlinked.append(path)

    def bind_socket(self, address):
        self.bound.append(address)
        return self.bind


FOLDER = os.path.abspath(os.path.join(os.sep, "zn-test", "state"))


class TestProbe(unittest.TestCase):
    def test_normal_folder(self):
        layer = FakeLayer()
        r = state_fs.support(FOLDER, layer)
        self.assertEqual(r, {"folder": FOLDER, "permissions_enforced": True, "unix_sockets": True})
        self.assertEqual(state_fs.problem_text(r), "")
        self.assertEqual(layer.chmods[0][1], 0o600)
        self.assertEqual(sorted(layer.unlinked), sorted(layer.created + layer.bound))

    def test_vfat(self):
        r = state_fs.support(FOLDER, FakeLayer(mode=0o755, bind=errno.EPERM))
        self.assertFalse(r["permissions_enforced"])
        self.assertFalse(r["unix_sockets"])
        text = state_fs.problem_text(r)
        self.assertIn(FOLDER, text)
        self.assertIn("ignores Unix file permissions and cannot hold Unix sockets", text)
        self.assertIn("set ZN_HOME to a folder on a disk with Unix permissions, such as your home disk", text)

    def test_only_one_missing(self):
        sock = state_fs.support(FOLDER, FakeLayer(bind=errno.ENOTSUP))
        self.assertTrue(sock["permissions_enforced"])
        self.assertFalse(sock["unix_sockets"])
        self.assertNotIn("readable by other users", state_fs.problem_text(sock))
        perm = state_fs.support(FOLDER, FakeLayer(mode=0o644))
        self.assertFalse(perm["permissions_enforced"])
        self.assertTrue(perm["unix_sockets"])
        self.assertNotIn("vault cannot run", state_fs.problem_text(perm))

    def test_probe_that_cannot_run_claims_nothing(self):
        for code in (errno.EROFS, errno.EACCES, errno.ENOSPC):
            self.assertTrue(state_fs.support(FOLDER, FakeLayer(create_error=code))["permissions_enforced"])
        for code in (errno.EACCES, errno.EADDRINUSE, errno.ENAMETOOLONG):
            self.assertTrue(state_fs.support(FOLDER, FakeLayer(bind=code))["unix_sockets"])
        layer = FakeLayer(bind=errno.EPERM)
        long_folder = os.path.abspath(os.path.join(os.sep, "zn-test", "x" * 120))
        self.assertTrue(state_fs.support(long_folder, layer)["unix_sockets"])
        self.assertEqual(layer.bound, [])

    def test_missing_folder_probes_the_parent_and_run_is_used(self):
        parent = os.path.abspath(os.path.join(os.sep, "zn-test"))
        layer = FakeLayer(dirs=[parent])
        state_fs.support(os.path.join(parent, "new", "deeper"), layer)
        self.assertEqual(os.path.dirname(layer.created[0]), parent)
        with_run = FakeLayer(dirs=[FOLDER, os.path.join(FOLDER, "run")])
        state_fs.support(FOLDER, with_run)
        self.assertEqual(os.path.dirname(with_run.bound[0]), os.path.join(FOLDER, "run"))

    @unittest.skipIf(os.name == "nt", "Windows uses ACLs and pipes")
    def test_real_folder_and_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = os.path.join(tmp, "state")
            state_fs.clear_cache()
            r = state_fs.support(folder)
            self.assertTrue(r["permissions_enforced"] and r["unix_sockets"])
            self.assertFalse(os.path.exists(folder))
            self.assertEqual(os.listdir(tmp), [])
            with mock.patch.object(state_fs, "_probe_permissions", side_effect=AssertionError("probed twice")):
                self.assertEqual(state_fs.support(folder), r)


def run_check(env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch("sys.argv", ["zn-gate", "check"]), redirect_stdout(out), redirect_stderr(err):
        code = cli.main()
    return code, out.getvalue() + err.getvalue()


class TestCheckWarning(unittest.TestCase):
    def test_warning_names_folder_and_fix_and_keeps_exit_code(self):
        bad = {"folder": FOLDER, "permissions_enforced": False, "unix_sockets": False}
        with mock.patch.object(state_fs, "support", return_value=bad):
            code, text = run_check()
        self.assertEqual(code, 0, text)
        warning = [l for l in text.splitlines() if l.startswith("Warning:")]
        self.assertEqual(len(warning), 1, text)
        self.assertIn(FOLDER, warning[0])
        self.assertIn("set ZN_HOME", warning[0])

    def test_no_warning_on_a_normal_folder(self):
        good = {"folder": FOLDER, "permissions_enforced": True, "unix_sockets": True}
        with mock.patch.object(state_fs, "support", return_value=good):
            code, text = run_check()
        self.assertEqual(code, 0, text)
        self.assertNotIn("Warning:", text)

    def test_probe_failure_never_breaks_check(self):
        with mock.patch.object(state_fs, "support", side_effect=RuntimeError("boom")):
            code, text = run_check()
        self.assertEqual(code, 0, text)
        self.assertNotIn("Warning:", text)

    def test_same_words_as_the_npm_package(self):
        import json
        import shutil
        import subprocess
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js not available")
        pkg = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "zn-gate", "lib", "state-fs.js"))
        if not os.path.exists(pkg):
            self.skipTest("npm package not next to this one")
        for info in ({"folder": FOLDER, "permissions_enforced": False, "unix_sockets": False},
                     {"folder": FOLDER, "permissions_enforced": False, "unix_sockets": True},
                     {"folder": FOLDER, "permissions_enforced": True, "unix_sockets": False}):
            script = "process.stdout.write(require(process.argv[1]).problemText(JSON.parse(process.argv[2])))"
            out = subprocess.run([node, "-e", script, pkg, json.dumps(info)], capture_output=True, text=True, check=True).stdout
            self.assertEqual(out, state_fs.problem_text(info))


if __name__ == "__main__":
    unittest.main()
