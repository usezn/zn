"""Where a GitHub key ends, in both engines (fake keys only).

The next line is kept after a complete key when it is a word; a key that wraps onto a line of key material is
redacted whole. The Node.js package has the same cases (test/scrub_github_token_end.test.js) and the outputs are
compared here.
"""

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
R = "[REDACTED_GITHUB_TOKEN]"
rnd = random.Random(20261129)


def random_body(n):
    while True:
        b = "".join(rnd.choice(ALNUM) for _ in range(n))
        if any(c.isdigit() for c in b) and any(c.isupper() for c in b) and any(c.islower() for c in b):
            return b


def cases():
    """(text, expected output, or None when only the key text must be gone)."""
    out = []
    words = ["run-deploy now", "rundeployment.", "deploynowplease", "run_deploy_x --now", "next.line.here-x", "./run-deploy.sh"]
    for prefix in ("ghp_", "gho_", "ghu_", "ghs_", "ghr_"):
        for n in (36, 40, 60, 100):
            for word in words:
                for lead in ("export T=", "", "token: "):
                    key = prefix + random_body(n)
                    for eol in ("\n", "\r\n"):
                        out.append((lead + key + eol + word + "\n", lead + R + eol + word + "\n"))
    key = "ghp_" + random_body(36)
    out.append(("x " + key + "-word y", "x " + R + "-word y"))
    out.append((key + ".next y", R + ".next y"))
    out.append(("(" + key + "),\nfoo", "(" + R + "),\nfoo"))
    out.append((key + ".\nrun-deploy-now", R + ".\nrun-deploy-now"))
    for n in (36, 60, 100, 200):
        for first in (14, 20, 30, 76):
            if first >= n - 9:
                continue
            body = random_body(n)
            out.append(("export T=ghp_" + body[:first] + "\n" + body[first:] + "\nnext\n", None))
    for n in (100, 150, 255):
        body = random_body(n)
        out.append(("ghp_" + body[:76] + "\n" + body[76:], R))
    return out


class GithubTokenEnd(unittest.TestCase):
    def test_python_keeps_the_next_line_and_redacts_wrapped_keys(self):
        for text, want in cases():
            got = redact_secrets(text)[0]
            if want is None:
                self.assertTrue(got.endswith("\nnext\n"), got[-20:])
                self.assertNotIn("ghp_", got)
                body = text.split("ghp_", 1)[1].replace("\n", "")
                for k in range(0, len(body) - 8 - 5):
                    self.assertNotIn(body[k:k + 8], got)
            else:
                self.assertEqual(got, want, text[:14])

    @unittest.skipUnless(HAVE_NODE, "needs the monorepo checkout and node")
    def test_node_gives_the_same_output(self):
        texts = [t for t, _ in cases()]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf8") as f:
            json.dump(texts, f)
            name = f.name
        try:
            res = subprocess.run(["node", str(DRIVER), name], capture_output=True, text=True, encoding="utf-8", timeout=120, check=True)
        finally:
            Path(name).unlink(missing_ok=True)
        node = json.loads(res.stdout)
        for text, n in zip(texts, node, strict=True):
            self.assertEqual(n.get("out"), redact_secrets(text)[0], text[:14])


if __name__ == "__main__":
    unittest.main()
