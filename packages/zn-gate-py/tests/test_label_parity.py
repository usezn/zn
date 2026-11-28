"""The Node.js and Python packages give the same secret the same name.

test_secret_scrub_parity.py compares what each engine hides (the spans). This one compares how it is named,
on a corpus of fake secrets built here from a seeded generator (a public prefix and a random body, never a real
credential):
  * the redaction label and the rule ids of redact_secrets (Node.js redactSecrets) must be equal;
  * the secret types `zn-gate reach --history` counts (STRIPE_KEY, SLACK_TOKEN, HF_TOKEN, DB_PASSWORD...) must be
    equal, so the report says the same in both packages.
Both are public output (the redacted text goes to the agent and the log, the types to the reach report), so a
name is never changed here: a case whose names still differ is listed in KNOWN with its reason, and must still
differ so the list cannot go stale. These tests need the monorepo checkout and a `node` binary; they are skipped
with a message when either is missing (for example when testing an sdist).
"""

import json
import random
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate import reach_history
from zn_gate.rules import mask_pii_preview, redact_secrets

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
EXPORT_SCRIPT = NODE_PKG / "test" / "helpers" / "export_label_parity.js"

ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
HEX = "0123456789abcdef"
DIGITS = "0123456789"
URLSAFE = ALNUM + "_-"
rnd = random.Random(20261129)


def r(n, alphabet=ALNUM):
    return "".join(rnd.choice(alphabet) for _ in range(n))


CASES = []


def case(label, text):
    CASES.append((label, text))


# Keys under a generic NAME=: the redaction label is the generic one in both packages, the reach type the specific one.
case("stripe live, python style", "stripe.api_key = '" + "sk_" + "live_" + r(24) + "'")
case("stripe webhook", "STRIPE_WEBHOOK_SECRET=" + "whsec_" + r(32))
case("slack bot token", "SLACK_BOT_TOKEN=" + "xox" + "b-%s-%s-%s" % (r(12, DIGITS), r(12, DIGITS), r(24)))
case("sendgrid", "SENDGRID_API_KEY=" + "SG." + r(22, URLSAFE) + "." + r(43, URLSAFE))
case("twilio api key", "TWILIO_API_KEY=" + "SK" + r(32, HEX))
case("twilio auth token env", "TWILIO_AUTH_TOKEN=" + r(32, HEX))
case("twilio auth token yaml", "twilio:\n  auth_token: " + r(32, HEX) + "\n")
case("twilio auth token json", '{"auth_token": "' + r(32, HEX) + '"}')
case("hugging face", "HF_TOKEN=" + "hf_" + r(34))
case("gitlab", "GITLAB_TOKEN=" + "glpat-" + r(20, URLSAFE))
case("azure ad client secret", "AZURE_CLIENT_SECRET=" + r(3) + "8Q~" + r(34, URLSAFE))
# Keys on their own.
case("stripe bare", "value: " + "sk_" + "live_" + r(24))
case("slack bare", "value: " + "xox" + "b-%s-%s-%s" % (r(12, DIGITS), r(12, DIGITS), r(24)))
case("github token", "token: " + "ghp_" + r(36))
case("github fine-grained", "token: " + "github_pat_" + r(22) + "_" + r(59))
case("hugging face bare", "value: " + "hf_" + r(34))
case("aws key id", "aws_access_key_id = AKIA" + r(16, UPPER))
# Passwords in URLs: the web schemes are URL_PASSWORD, any other scheme DB_PASSWORD, in redaction and in reach.
case("https url", "git clone https://deploy:" + r(14) + "@git.example.com/org/repo.git")
case("postgres url", "DATABASE_URL=postgres://appuser:" + r(16) + "@db.example.com:5432/app")
case("mongodb+srv url", "MONGO=mongodb+srv://svc:" + r(16) + "@cluster0.example.com/db")
case("redis url without user", "redis://:" + r(16) + "@cache.example.com:6379/0")
case("amqp url", "BROKER=amqp://worker:" + r(16) + "@mq.example.com:5672/")
case("ssh url", "origin = ssh://git:" + r(16) + "@git.example.com/repo.git")

# Names that still differ, each with its reason. Empty today.
KNOWN = {}


def node_out(texts):
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed: skipping the Node.js/Python label parity check")
    if not EXPORT_SCRIPT.exists():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the label parity check")
    with tempfile.TemporaryDirectory() as tmp:
        cases = Path(tmp) / "cases.json"
        cases.write_text(json.dumps(texts), encoding="utf8")
        out = subprocess.run([node, str(EXPORT_SCRIPT), str(cases)], cwd=tmp, check=True,
                             capture_output=True, timeout=300).stdout
    return json.loads(out.decode("utf8"))


def python_out(text):
    sanitized, detections = redact_secrets(text)
    counts = {}
    reach_history.scan_line(text, counts)
    return {"sanitized": sanitized, "rules": [d["rule"] for d in detections], "reach": counts,
            "scrub": mask_pii_preview(sanitized)}


# The shape of the scrubbed text (what stays readable, where the quotes are) for a credential in a URL or a quoted
# value. The label of a password is not compared here (URL_PASSWORD, DB_PASSWORD, SECRET, PASSWORD: each is public
# in its package); the text around it is, character for character.
SHAPE_CASES = [
    "git clone https://deploy:" + r(14) + "@git.example.com/org/repo.git",
    "DATABASE_URL=postgres://appuser:" + r(16) + "@db.example.com:5432/app",
    "MONGO=mongodb+srv://svc:" + r(16) + "@cluster0.example.com/db?retryWrites=true",
    "redis://:" + r(16) + "@cache.example.com:6379/0",
    "password = '" + "Zx9!" + r(14) + "'",
    'password = "' + "Zx9!" + r(14) + '"',
    "password: " + "Zx9!" + r(14),
    "mail maria.ejemplo@example.com about https://deploy:" + r(14) + "@git.example.com/x",
]
_PW_LABEL = __import__("re").compile(r"\[REDACTED_(?:URL_PASSWORD|DB_PASSWORD|SECRET|PASSWORD)\]")


class LabelParity(unittest.TestCase):
    def test_credential_shape_is_the_same(self):
        js = node_out(SHAPE_CASES)
        for text, n in zip(SHAPE_CASES, js):
            p = python_out(text)["scrub"]
            with self.subTest(text=_PW_LABEL.sub("[PW]", text[:12])):
                self.assertEqual(_PW_LABEL.sub("[PW]", n["scrub"]), _PW_LABEL.sub("[PW]", p))
                self.assertNotIn("Zx9!", n["scrub"])
                self.assertNotIn("Zx9!", p)
                if "@git.example.com" in text:
                    self.assertIn("@git.example.com", n["scrub"])
                    self.assertIn("@git.example.com", p)
                if text.startswith("password = '") or text.startswith('password = "'):
                    self.assertEqual(n["scrub"][11], text[11])
                    self.assertEqual(p[11], text[11])

    def test_same_names_in_both_packages(self):
        texts = [t for _label, t in CASES]
        js = node_out(texts)
        self.assertEqual(len(js), len(texts))
        differ = {}
        for (label, text), n in zip(CASES, js):
            p = python_out(text)
            for key in ("sanitized", "rules", "reach"):
                if n[key] != p[key]:
                    differ.setdefault(label, []).append("%s\n    node:   %s\n    python: %s" % (key, n[key], p[key]))
        unexpected = {k: v for k, v in differ.items() if k not in KNOWN}
        stale = sorted(k for k in KNOWN if k not in differ)
        self.assertFalse(stale, "listed in KNOWN but no longer differ: %s" % stale)
        detail = "\n".join("%s\n  %s" % (k, "\n  ".join(v)) for k, v in unexpected.items())
        self.assertFalse(unexpected, "the packages name these secrets differently:\n" + detail)

    def test_reach_types_are_specific(self):
        # The point of the reach parity: a key under a generic name is counted by its own type, not as SECRET.
        counts = {}
        reach_history.scan_line("HF_TOKEN=" + "hf_" + r(34), counts)
        self.assertEqual(counts, {"HF_TOKEN": 1})
        counts = {}
        reach_history.scan_line("redis://:" + r(16) + "@cache.example.com:6379/0", counts)
        self.assertEqual(counts, {"DB_PASSWORD": 1})
        counts = {}
        reach_history.scan_line("git clone https://deploy:" + r(14) + "@git.example.com/org/repo.git", counts)
        self.assertEqual(counts, {"URL_PASSWORD": 1})


if __name__ == "__main__":
    unittest.main()
