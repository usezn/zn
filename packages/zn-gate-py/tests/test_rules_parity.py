"""The Python rules must stay identical to the Node.js rules in packages/zn-gate.

The Node.js side is exported as JSON by packages/zn-gate/test/helpers/export_rules.js.
These tests need the monorepo checkout and a `node` binary; they are skipped
with a message when either is missing (for example when testing an sdist).
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate import rules as R

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
EXPORT_SCRIPT = NODE_PKG / "test" / "helpers" / "export_rules.js"
SAMPLES_FILE = NODE_PKG / "test" / "fixtures" / "rules_parity_samples.json"

# Secret patterns whose Python form differs on purpose, with the reason.
SECRET_PATTERN_EXCEPTIONS: dict = {}


def _expand(sample):
    if isinstance(sample, str):
        return sample
    return sample.get("prefix", "") + sample["repeat"] * sample["times"] + sample.get("suffix", "")


def _py_table(entries):
    return [(rule_id, pat.pattern, bool(pat.flags & re.IGNORECASE)) for rule_id, pat, _ in entries]


def _js_table(entries):
    return [(e["id"], e["source"], "i" in e["flags"]) for e in entries]


def _js_regex(e):
    return (e["source"], "i" in e["flags"])


def _py_regex(pat):
    return (pat.pattern, bool(pat.flags & re.IGNORECASE))


_EXPORT = None


def _node_export():
    global _EXPORT
    if _EXPORT is None:
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node is not installed: skipping the Node.js/Python rules parity check")
        if not EXPORT_SCRIPT.is_file() or not SAMPLES_FILE.is_file():
            raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the rules parity check")
        # Run from an empty directory so no .znrules / zn.config.json is picked up.
        with tempfile.TemporaryDirectory() as cwd:
            proc = subprocess.run(
                [node, str(EXPORT_SCRIPT), str(SAMPLES_FILE)],
                cwd=cwd, capture_output=True, timeout=120, check=True,
            )
        _EXPORT = json.loads(proc.stdout.decode("utf-8"))
    return _EXPORT


class TestPatternParity(unittest.TestCase):
    def setUp(self):
        self.js = _node_export()

    def test_rules_version(self):
        self.assertEqual(self.js["rules_version"], R.RULES_VERSION)

    def test_detection_tables(self):
        for name in ("INJECTION_RULES", "INDIRECT_INJECTION_RULES", "EVASION_RULES",
                     "SENSITIVE_PATH_RULES", "MARKDOWN_EXFIL_RULES"):
            with self.subTest(table=name):
                self.assertEqual(_py_table(getattr(R, name)), _js_table(self.js["tables"][name]))

    def test_exfil_compound(self):
        (rule,) = self.js["exfil"]
        self.assertEqual(rule["id"], "exfil:credentials")
        self.assertEqual([_py_regex(R.EXFIL_VERBS), _py_regex(R.CRED_OBJECTS)],
                         [_js_regex(e) for e in rule["compound"]])

    def test_helper_patterns(self):
        for name, e in self.js["helpers"].items():
            with self.subTest(helper=name):
                self.assertEqual(_py_regex(getattr(R, name)), _js_regex(e))

    def test_secret_patterns(self):
        js = {e["id"]: e for e in self.js["tables"]["SECRET_PATTERNS"]}
        py = {rule_id: pat for rule_id, pat, _ in R.SECRET_PATTERNS}
        self.assertEqual(list(py), list(js))
        for rule_id, pat in py.items():
            if rule_id in SECRET_PATTERN_EXCEPTIONS:
                continue
            with self.subTest(rule=rule_id):
                self.assertEqual(_py_regex(pat), _js_regex(js[rule_id]))
        self.assertEqual(R.SECRET_PATTERN_REQUIRES, self.js["secret_requires"])

    def test_size_limits(self):
        for name, value in self.js["limits"].items():
            with self.subTest(limit=name):
                self.assertEqual(getattr(R, name), value)


class TestBehaviourParity(unittest.TestCase):
    def test_same_verdicts_on_shared_samples(self):
        js = _node_export()
        samples = json.loads(SAMPLES_FILE.read_text(encoding="utf-8"))["samples"]
        self.assertEqual(len(samples), len(js["results"]))
        for i, (sample, expected) in enumerate(zip(samples, js["results"])):
            text = _expand(sample)
            res = R.evaluate(text)
            label = f"sample {i}: {text[:40]!r}"
            with self.subTest(sample=label):
                self.assertEqual(
                    (res.verdict, res.rule, res.truncated),
                    (expected["verdict"], expected["rule"], expected["truncated"]),
                )
                scan = R.scan_windows(text)
                self.assertEqual(
                    (scan.verdict, scan.rule, scan.truncated),
                    (expected["scan"]["verdict"], expected["scan"]["rule"], expected["scan"]["truncated"]),
                )
                if expected["stripped"] is not None:
                    self.assertEqual(R.normalize_input(text)[1], expected["stripped"])

    def test_same_redaction_on_shared_samples(self):
        js = _node_export()
        samples = json.loads(SAMPLES_FILE.read_text(encoding="utf-8"))["redact_samples"]
        self.assertEqual(len(samples), len(js["redactions"]))
        for i, (sample, expected) in enumerate(zip(samples, js["redactions"])):
            text = _expand(sample)
            redacted, found = R.redact_secrets(text)
            with self.subTest(sample=i):
                self.assertEqual([d["rule"] for d in found], expected["rules"])
                if not set(expected["rules"]) & set(SECRET_PATTERN_EXCEPTIONS):
                    self.assertEqual(redacted, expected["sanitized"])


class TestAsciiTokenBoundaries(unittest.TestCase):
    """A key next to a non-ASCII letter is still a separate token."""

    def test_keys_next_to_non_ascii_letters_are_redacted(self):
        cases = [
            ("clé" + "AKIA" + "Z" * 16 + "é", "secret:aws_access_key"),
            ("ñ" + "ghp_" + "a" * 36 + "ü", "secret:github_token"),
            ("ç" + "sk-ant-" + "b" * 32 + "ß", "secret:anthropic_key"),
            ("ä" + "sk-proj-" + "c" * 30 + "ä", "secret:openai_key"),
            ("é" + "API_KEY=" + "d4" * 8, "secret:env_credential"),
        ]
        for text, rule in cases:
            with self.subTest(rule=rule):
                redacted, found = R.redact_secrets(text)
                self.assertIn(rule, [d["rule"] for d in found])
                self.assertNotIn("Z" * 16, redacted)
                self.assertNotIn("a" * 36, redacted)
                self.assertNotIn("b" * 32, redacted)
                self.assertNotIn("c" * 30, redacted)
                self.assertNotIn("d4" * 8, redacted)

    def test_ascii_neighbours_still_do_not_match(self):
        for text in ("x" + "AKIA" + "Z" * 16, "AKIA" + "Z" * 16 + "_x", "my_" + "api_key=" + "d" * 16):
            with self.subTest(text=text[:12]):
                self.assertEqual(R.redact_secrets(text)[1], [])


class TestPrefixedCredentialNames(unittest.TestCase):
    """Environment-style names with a prefix are redacted; references and code are not."""

    def test_prefixed_names_are_redacted(self):
        value = "v4lue" + "Q" * 20
        for name in ("OPENAI_API_KEY", "STRIPE_SECRET_KEY", "GITHUB_AUTH_TOKEN", "MY_API_KEY",
                     "PROD_AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "APP_SECRET", "SLACK_BOT_TOKEN"):
            for sep in ("=", ": ", " = ", '="'):
                with self.subTest(name=name, sep=sep):
                    redacted, found = R.redact_secrets(name + sep + value)
                    self.assertNotIn(value, redacted)
                    self.assertTrue(found)

    def test_more_names_json_and_dockerfile(self):
        value = "Zx9" + "kQ" * 10
        for text in ('"OPENAI_API_KEY": "' + value + '"', "'DB_PASSWORD': '" + value + "'",
                     "SENDGRID_APIKEY=" + value, "MAILGUN_ACCESS_KEY=" + value, "POSTGRES_PASS=" + value,
                     "REDIS_PWD=" + value, "REDIS_PASSWD=" + value, "GCP_CREDENTIALS=" + value,
                     "ENV HF_TOKEN " + value, "ENV STRIPE_SECRET_KEY=" + value,
                     '{"api_key": "' + value + '"}'):
            with self.subTest(text=text[:24]):
                redacted, found = R.redact_secrets(text)
                self.assertNotIn(value, redacted)
                self.assertTrue(found)

    def test_code_placeholders_and_vault_markers_are_left_alone(self):
        for text in ("const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;",
                     "  OPENAI_API_KEY: process.env.OPENAI_API_KEY,",
                     'DB_PASSWORD = os.environ.get("DB_PASSWORD")', 'API_KEY = os.getenv("API_KEY")',
                     "SLACK_BOT_TOKEN = settings.SLACK_BOT_TOKEN", "GH_TOKEN: core.getInput('token')",
                     "OPENAI_API_KEY=your-openai-api-key-here", "STRIPE_SECRET_KEY=" + "x" * 24,
                     "APP_SECRET=REPLACE_ME_WITH_REAL", "MY_API_KEY=placeholder-value-123",
                     "SERVICE_TOKEN=EXAMPLE_VALUE_ONLY", 'FORCE_CHANGE_PASSWORD = "FORCE_CHANGE_PASSWORD"',
                     "DB_PASSWORD=__ZN_DB_PASSWORD__", "GITHUB_TOKEN=__ZN_GITHUB_TOKEN__",
                     "API_TOKEN: Optional[str] = None", 'AWS_TOKEN_HEADER = "x-aws-ec2-metadata-token"',
                     "SERVICE_API_KEY=zn_live_your_key"):
            with self.subTest(text=text[:32]):
                self.assertEqual(R.redact_secrets(text)[1], [])

    def test_openrouter_langfuse_and_short_legacy_keys(self):
        for key in ("sk-or-v1-" + "a1b2" * 16, "sk-lf-" + "c3d4-" * 8 + "e5f6", "sk-" + "Ab3x" * 7):
            with self.subTest(key=key[:9]):
                redacted, found = R.redact_secrets("Authorization: Bearer " + key)
                self.assertNotIn(key, redacted)
                self.assertIn("secret:openai_key", [d["rule"] for d in found])

    def test_private_key_with_repeated_headers(self):
        body = "MII" + "Cd" * 30
        text = "-----BEGIN PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\n" + body + "\n-----END RSA PRIVATE KEY-----"
        redacted = R.redact_secrets(text)[0]
        self.assertNotIn(body, redacted)
        self.assertIn("[REDACTED_PRIVATE_KEY]", redacted)

    def test_references_and_code_are_left_alone(self):
        for text in ("GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}", "SERVICE_PASSWORD=${SERVICE_PASSWORD}",
                     "DEPLOY_TOKEN=$DEPLOY_TOKEN_FROM_CI", "OPENAI_API_KEY=<your-openai-key>",
                     "WIN_SECRET=%WINDOWS_SECRET_VAR%", "MAX_TOKEN=4096",
                     "token = response.json()", "user_password = form.get_value()",
                     "my_api_key=" + "d" * 16):
            with self.subTest(text=text):
                self.assertEqual(R.redact_secrets(text)[1], [])

    def test_case_folding_matches_nodejs(self):
        # Python's re folds K (Kelvin sign), \u017f and \u0131 into ASCII letters
        # under IGNORECASE; the patterns use explicit [Aa] classes instead.
        value = "d4" * 8
        self.assertTrue(R.redact_secrets("\u212aAPI_KEY=" + value)[1])
        self.assertEqual(R.redact_secrets("\u017fECRET_KEY=" + value)[1], [])

    def test_openai_pattern_skips_hyphenated_slugs(self):
        slug = "/gda\u0144sk-to-warsaw-train-schedule-2026-autumn-edition"
        self.assertEqual(R.redact_secrets(slug)[1], [])
        legacy = "sk-" + "A1" * 24
        self.assertIn("secret:openai_key", [d["rule"] for d in R.redact_secrets(legacy)[1]])
        project = "sk-proj-" + "a_b-" * 10
        self.assertIn("secret:openai_key", [d["rule"] for d in R.redact_secrets(project)[1]])

    def test_aws_secret_keeps_quotes_in_both_engines(self):
        secret = "A" * 20 + "/" + "b" * 19
        out = R.redact_secrets('aws_secret_access_key = "' + secret + '"')[0]
        self.assertNotIn(secret, out)
        self.assertTrue(out.startswith('aws_secret_access_key = "') and out.endswith('"'), out)


if __name__ == "__main__":
    unittest.main()
