"""GitHub tokens with a body of 36 to 255 characters are redacted whole by both engines (fake keys only)."""

import json
import random
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate.rules import redact_secrets

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
DRIVER = NODE_PKG / "test" / "helpers" / "export_redaction_safe.js"
HAVE_NODE = shutil.which("node") is not None and DRIVER.exists()

ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
PREFIXES = ("ghp_", "gho_", "ghu_", "ghs_", "ghr_")
LENGTHS = (36, 40, 41, 60, 100, 255)
rnd = random.Random(20261128)


def cases():
    out = []
    for prefix in PREFIXES:
        for n in LENGTHS:
            key = prefix + "".join(rnd.choice(ALNUM) for _ in range(n))
            out.append((key, "see " + key + " here"))
            out.append((key, "GH_TOKEN=" + key + "\n"))
            out.append((key, '"' + key + '".'))
    return out


class GithubTokenLength(unittest.TestCase):
    def test_python_redacts_every_length(self):
        for key, text in cases():
            out = redact_secrets(text)[0]
            self.assertNotIn(key[4:12], out, text[:12])
            self.assertIn("[REDACTED_GITHUB_TOKEN]", out)

    @unittest.skipUnless(HAVE_NODE, "needs the monorepo checkout and node")
    def test_node_gives_the_same_output(self):
        texts = [t for _, t in cases()]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf8") as f:
            json.dump(texts, f)
            name = f.name
        try:
            res = subprocess.run(["node", str(DRIVER), name], capture_output=True, text=True, encoding="utf-8", timeout=120, check=True)
        finally:
            Path(name).unlink(missing_ok=True)
        node = json.loads(res.stdout)
        for text, n in zip(texts, node, strict=True):
            self.assertEqual(n.get("out"), redact_secrets(text)[0], text[:12])


if __name__ == "__main__":
    unittest.main()
