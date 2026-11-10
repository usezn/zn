"""`zn_gate stats` ignores top-level keys it does not know in its stats file."""

import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"


class StatsIgnoresUnknownKeys(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = self._tmp.name
        self.today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        data = {
            "version": 1,
            "days": {
                self.today: {
                    "hook:claude-code": {"checked": 5, "blocked": 2, "warned": 0, "redacted": 1,
                                         "detections": {"AWS_KEY": 1}},
                },
            },
            "events": {},
            "future_feature": {"nested": [1, 2, 3], "note": "written by a newer version"},
        }
        with open(os.path.join(self.home, "stats.json"), "w", encoding="utf-8") as f:
            json.dump(data, f)

    def tearDown(self):
        self._tmp.cleanup()

    def _env(self):
        env = dict(os.environ)
        env["ZN_HOME"] = self.home
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONPATH"] = str(SRC) + os.pathsep + env.get("PYTHONPATH", "")
        return env

    def test_text_output_shows_known_numbers(self):
        res = subprocess.run([sys.executable, "-m", "zn_gate.cli", "stats"], capture_output=True,
                             text=True, env=self._env(), timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("5 events checked", res.stdout)
        self.assertIn("AWS_KEY 1", res.stdout)

    def test_json_output_keeps_known_totals(self):
        res = subprocess.run([sys.executable, "-m", "zn_gate.cli", "stats", "--json"],
                             capture_output=True, text=True, env=self._env(), timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out["total"], {"checked": 5, "blocked": 2, "warned": 0, "redacted": 1})
        self.assertEqual(out["detections"], {"AWS_KEY": 1})


if __name__ == "__main__":
    unittest.main()
