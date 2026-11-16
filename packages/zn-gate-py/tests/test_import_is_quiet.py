"""Importing zn_gate is quiet: no optional frameworks, no network, no files."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")

PROBE = r"""
import json, socket, sys

attempts = []

def _deny(name):
    def fn(*a, **k):
        attempts.append(name)
        raise OSError("network disabled in test")
    return fn

socket.socket.connect = _deny("connect")
socket.socket.connect_ex = _deny("connect_ex")
socket.create_connection = _deny("create_connection")
socket.getaddrinfo = _deny("getaddrinfo")
socket.gethostbyname = _deny("gethostbyname")

import zn_gate

blocked = ("langchain", "llama_index", "crewai")
loaded = sorted(
    m for m in sys.modules
    if any(m == b or m.startswith(b + ".") or m.startswith(b + "_") for b in blocked)
)
print(json.dumps({"loaded": loaded, "attempts": attempts,
                  "file": zn_gate.__file__}))
"""


class TestImportIsQuiet(unittest.TestCase):
    def test_import_loads_no_frameworks_no_network_no_files(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            env = {
                k: v for k, v in os.environ.items()
                if not k.startswith("ZN_") and k != "PYTHONPATH"
            }
            env.update({
                "HOME": home,
                "USERPROFILE": home,
                "XDG_CONFIG_HOME": os.path.join(home, ".config"),
                "XDG_CACHE_HOME": os.path.join(home, ".cache"),
                "XDG_DATA_HOME": os.path.join(home, ".local", "share"),
                "PYTHONPATH": os.path.abspath(SRC),
                "PYTHONDONTWRITEBYTECODE": "1",
            })
            proc = subprocess.run(
                [sys.executable, "-c", PROBE],
                env=env, cwd=cwd, capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout.strip().splitlines()[-1])
            self.assertEqual(result["loaded"], [])
            self.assertEqual(result["attempts"], [])
            self.assertEqual(proc.stderr, "")
            self.assertEqual(os.listdir(home), [])
            self.assertEqual(os.listdir(cwd), [])


if __name__ == "__main__":
    unittest.main()
