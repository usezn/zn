"""Imports stay lazy: submodules load on first use, and every public name still works.

Each check runs in a fresh interpreter (python -I), so modules loaded by the
test runner itself cannot hide a regression.
"""
import os
import subprocess
import sys
import unittest

SRC = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

PREAMBLE = "import sys\nsys.path.insert(0, %r)\n" % SRC


def run_fresh(code):
    proc = subprocess.run(
        [sys.executable, "-I", "-c", PREAMBLE + code],
        capture_output=True, text=True, timeout=60,
    )
    return proc


class TestPackageImportIsLazy(unittest.TestCase):
    def test_import_does_not_load_deferred_submodules(self):
        proc = run_fresh(
            "import zn_gate\n"
            "deferred = ['zn_gate.guard', 'zn_gate.destructive', 'zn_gate.evidence', 'zn_gate.client']\n"
            "loaded = [m for m in deferred if m in sys.modules]\n"
            "assert not loaded, loaded\n"
            "print('ok')\n"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "ok")

    def test_every_public_name_still_resolves(self):
        proc = run_fresh(
            "import inspect\n"
            "import zn_gate\n"
            "missing = [n for n in zn_gate.__all__ if not hasattr(zn_gate, n)]\n"
            "assert not missing, missing\n"
            "from zn_gate import guard, check_tool_call, check_tool_result, check_command\n"
            "from zn_gate import GuardBlockError, log_evidence, verify_evidence_ledger\n"
            "from zn_gate import get_evidence_stats, export_evidence_ledger, GENESIS_HASH\n"
            "from zn_gate import analyze, analyze_cloud, is_cloud_enabled, resolve_endpoint\n"
            "assert inspect.isfunction(zn_gate.guard) and inspect.isfunction(guard)\n"
            "assert inspect.isclass(zn_gate.GuardBlockError)\n"
            "assert isinstance(zn_gate.GENESIS_HASH, str)\n"
            "for n in zn_gate.__all__:\n"
            "    assert n in dir(zn_gate), n\n"
            "print('ok')\n"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "ok")

    def test_public_names_work_after_first_use(self):
        proc = run_fresh(
            "import zn_gate\n"
            "allowed = zn_gate.check_tool_call('search', {'q': 'hello'}).allowed\n"
            "assert allowed is True, allowed\n"
            "assert zn_gate.check_command('ls -la') is not None\n"
            "assert 'zn_gate.guard' in sys.modules\n"
            "print('ok')\n"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "ok")

    def test_loading_the_submodule_keeps_the_guard_function(self):
        # A submodule import binds it as an attribute of the package. zn_gate.guard
        # must still be the public function afterwards, not the module.
        proc = run_fresh(
            "import importlib, inspect\n"
            "import zn_gate\n"
            "importlib.import_module('zn_gate.guard')\n"
            "assert inspect.isfunction(zn_gate.guard), type(zn_gate.guard)\n"
            "from zn_gate import guard\n"
            "assert inspect.isfunction(guard)\n"
            "print('ok')\n"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "ok")


class TestCliImportIsLazy(unittest.TestCase):
    def test_cli_import_does_not_load_cloud_client(self):
        proc = run_fresh(
            "import zn_gate.cli\n"
            "assert 'zn_gate.client' not in sys.modules\n"
            "print('ok')\n"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "ok")

    def test_cli_cloud_wrapper_loads_client_on_use(self):
        proc = run_fresh(
            "import zn_gate.cli as cli\n"
            "assert 'zn_gate.client' not in sys.modules\n"
            "cli.is_cloud_enabled(local_only=True)\n"
            "assert 'zn_gate.client' in sys.modules\n"
            "print('ok')\n"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "ok")


if __name__ == "__main__":
    unittest.main()
