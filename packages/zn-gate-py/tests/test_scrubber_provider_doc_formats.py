"""Provider formats read from each vendor's own documentation: the Artifactory reference token (cmVmd, 64
characters), the Dynatrace dt0s0x token family, a 1Password service account token with a base64url body and a
SendGrid key longer than 69 characters.

Every key is fake and built at run time from a fixed alphabet and its public prefix, so no whole key sits in this
file. The Node.js scrubber has the same cases (test/scrub_provider_doc_formats.test.js); here the two engines
must also give the same redacted text. The Node side runs in a subprocess and the test is skipped without node.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate import rules as R

NODE_RULES = Path(__file__).resolve().parents[2] / "zn-gate" / "lib" / "rules.js"

AL = "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj0Ks"
UR = AL + "-_"
B64 = AL + "+/"
HX = "0123456789abcdef"


def body(n, alphabet=AL):
    return "".join(alphabet[(i * 7 + 3) % len(alphabet)] for i in range(n))


POSITIVES = [
    ("secret:artifactory_reference_token", "cmVmd" + body(59)),
    ("secret:dynatrace_platform_token", "dt0s01." + body(24) + "." + body(64)),
    ("secret:dynatrace_platform_token", "dt0s02." + body(24) + "." + body(64)),
    ("secret:dynatrace_platform_token", "dt0s16." + body(24) + "." + body(64)),
    ("secret:dynatrace_platform_token", "dt0s09." + body(24) + "." + body(64)),
    ("secret:onepassword_sa_token_base64url", "ops_eyJ" + body(250, UR)),
    ("secret:onepassword_sa_token_base64url", "ops_eyJ" + body(634, UR)),
    ("secret:sendgrid_key_long", "SG." + body(22, UR) + "." + body(44, UR)),
    ("secret:sendgrid_key_long", "SG." + body(22, UR) + "." + body(46, UR)),
    ("secret:sendgrid_key_long", "SG." + body(23, UR) + "." + body(43, UR)),
    ("secret:sendgrid_key_long", "SG." + body(33, UR) + "." + body(43, UR)),
    ("secret:sendgrid_key_long", "SG." + body(30, UR) + "." + body(66, UR)),
    ("secret:sendgrid_key_long", "SG." + body(22, UR) + "." + body(64, UR)),
]

NEAR_MISSES = [
    ("secret:artifactory_reference_token", "cmVmd" + body(58)),
    ("secret:artifactory_reference_token", "cmVmd" + body(60)),
    ("secret:artifactory_reference_token", "x" + "cmVmd" + body(59)),
    ("secret:artifactory_reference_token", "cmVmd" + "a" * 59),
    ("secret:dynatrace_platform_token", "dt0s01." + body(23) + "." + body(64)),
    ("secret:dynatrace_platform_token", "dt0s01." + body(24) + "." + body(63)),
    ("secret:dynatrace_platform_token", "dt0s1." + body(24) + "." + body(64)),
    ("secret:dynatrace_platform_token", "dt0s001." + body(24) + "." + body(64)),
    ("secret:dynatrace_platform_token", "adt0s01." + body(24) + "." + body(64)),
    ("secret:onepassword_sa_token_base64url", "ops_eyJ" + body(249, UR)),
    ("secret:onepassword_sa_token_base64url", "xops_eyJ" + body(250, UR)),
    ("secret:sendgrid_key_long", "SG." + body(21, UR) + "." + body(43, UR)),
    ("secret:sendgrid_key_long", "SG." + body(22, UR) + "." + body(42, UR)),
    ("secret:sendgrid_key_long", "x" + "SG." + body(22, UR) + "." + body(44, UR)),
    ("secret:sendgrid_key_long", "SG.xxxxxxxx.yyyyyyyy"),
]


def _forms(secret):
    return [secret, "the key " + secret + " was pasted", "export SERVICE_VALUE=" + secret + "\n",
            '{"value": "' + secret + '"}']


def _leaks(secret, out):
    return any(secret[i:i + 12] in out for i in range(0, len(secret) - 11, 3))


def _node_outputs(texts):
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed: skipping the Node.js comparison")
    if not NODE_RULES.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the Node.js comparison")
    script = (
        "const { redactSecrets } = require(process.argv[1]); let d = '';"
        "process.stdin.on('data', (c) => { d += c; }).on('end', () => {"
        " process.stdout.write(JSON.stringify(JSON.parse(d).map((t) => redactSecrets(t).sanitized))); });"
    )
    with tempfile.TemporaryDirectory() as cwd:
        proc = subprocess.run([node, "-e", script, str(NODE_RULES)], input=json.dumps(texts).encode("utf-8"),
                              cwd=cwd, capture_output=True, timeout=120, check=True)
    return json.loads(proc.stdout.decode("utf-8"))


class TestProviderDocFormats(unittest.TestCase):
    def test_each_positive_is_redacted_with_its_own_rule(self):
        for rule_id, secret in POSITIVES:
            with self.subTest(rule=rule_id, size=len(secret)):
                redacted, found = R.redact_secrets(secret)
                self.assertIn(rule_id, [d["rule"] for d in found])
                self.assertFalse(_leaks(secret, redacted))

    def test_no_readable_run_of_the_key_in_any_form(self):
        for _, secret in POSITIVES:
            for text in _forms(secret):
                with self.subTest(size=len(secret)):
                    self.assertFalse(_leaks(secret, R.redact_secrets(text)[0]))

    def test_near_misses_do_not_fire_the_new_rules(self):
        for rule_id, text in NEAR_MISSES:
            with self.subTest(rule=rule_id, size=len(text)):
                _, found = R.redact_secrets(text)
                self.assertNotIn(rule_id, [d["rule"] for d in found])

    def test_the_older_forms_keep_their_own_rules(self):
        cases = [
            ("secret:artifactory_key", "AKCp" + body(69)),
            ("secret:dynatrace_token", "dt0c01." + body(24) + "." + body(64)),
            ("secret:onepassword_sa_token", "ops_eyJ" + body(250, B64)),
            ("secret:sendgrid_key", "SG." + body(22, UR) + "." + body(43, UR)),
        ]
        for rule_id, secret in cases:
            with self.subTest(rule=rule_id):
                self.assertIn(rule_id, [d["rule"] for d in R.redact_secrets(secret)[1]])
        _, found = R.redact_secrets("dt0c01." + body(24) + "." + body(64))
        self.assertNotIn("secret:dynatrace_platform_token", [d["rule"] for d in found])
        _, found = R.redact_secrets("SG." + body(22, UR) + "." + body(43, UR))
        self.assertNotIn("secret:sendgrid_key_long", [d["rule"] for d in found])
        _, found = R.redact_secrets("ops_eyJ" + body(250, B64))
        self.assertNotIn("secret:onepassword_sa_token_base64url", [d["rule"] for d in found])

    def test_the_retired_teams_webhook_url_is_still_redacted(self):
        def uuid():
            return "-".join(body(n, HX) for n in (8, 4, 4, 4, 12))
        url = ("https://example.webhook.office.com/webhookb2/" + uuid() + "@" + uuid() + "/IncomingWebhook/"
               + body(32, HX) + "/" + uuid())
        redacted, found = R.redact_secrets("hook " + url)
        self.assertIn("secret:teams_webhook", [d["rule"] for d in found])
        self.assertFalse(_leaks(url[url.index("/webhookb2/"):], redacted))

    def test_node_gives_the_same_redacted_text(self):
        texts = [t for _, s in POSITIVES for t in _forms(s)] + [t for _, t in NEAR_MISSES]
        node = _node_outputs(texts)
        for text, out in zip(texts, node, strict=True):
            with self.subTest(size=len(text)):
                self.assertEqual(R.redact_secrets(text)[0], out)


if __name__ == "__main__":
    unittest.main()
