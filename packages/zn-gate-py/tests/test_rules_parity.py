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
            ("é" + "API_KEY=" + "d" * 16, "secret:env_credential"),
        ]
        for text, rule in cases:
            with self.subTest(rule=rule):
                redacted, found = R.redact_secrets(text)
                self.assertIn(rule, [d["rule"] for d in found])
                self.assertNotIn("Z" * 16, redacted)
                self.assertNotIn("a" * 36, redacted)
                self.assertNotIn("b" * 32, redacted)
                self.assertNotIn("c" * 30, redacted)
                self.assertNotIn("d" * 16, redacted)

    def test_ascii_neighbours_still_do_not_match(self):
        for text in ("x" + "AKIA" + "Z" * 16, "AKIA" + "Z" * 16 + "_x", "MY_" + "API_KEY=" + "d" * 16):
            with self.subTest(text=text[:12]):
                self.assertEqual(R.redact_secrets(text)[1], [])


class TestValidatedSecretPatterns(unittest.TestCase):
    """OpenAI key prefixes, private keys with repeated headers, ASCII case folding."""

    def test_openrouter_langfuse_and_short_legacy_keys(self):
        for key in ("sk-or-v1-" + "a1b2" * 16, "sk-lf-" + "c3d4-" * 8 + "e5f6", "sk-" + "Ab3x" * 7,
                    "sk-admin-" + "Zy9" * 10, "sk-None-" + "Q1w" * 10):
            with self.subTest(key=key[:9]):
                redacted, found = R.redact_secrets("Authorization: Bearer " + key)
                self.assertNotIn(key, redacted)
                self.assertIn("secret:openai_key", [d["rule"] for d in found])

    def test_legacy_key_followed_by_an_underscore(self):
        key = "sk-" + "Qw3e" * 12
        redacted, found = R.redact_secrets("OPENAI_KEY=" + key + "_backup")
        self.assertEqual(redacted, "OPENAI_KEY=[REDACTED_OPENAI_KEY]_backup")
        self.assertIn("secret:openai_key", [d["rule"] for d in found])

    def test_openai_pattern_skips_hyphenated_slugs(self):
        slug = "/gdańsk-to-warsaw-train-schedule-2026-autumn-edition"
        self.assertEqual(R.redact_secrets(slug)[1], [])
        legacy = "sk-" + "A1" * 24
        self.assertIn("secret:openai_key", [d["rule"] for d in R.redact_secrets(legacy)[1]])
        project = "sk-proj-" + "a_b-" * 10
        self.assertIn("secret:openai_key", [d["rule"] for d in R.redact_secrets(project)[1]])

    def test_helicone_alibaba_and_marked_openai_keys(self):
        group = "a1b2c3d"
        for key in ("sk-helicone-" + "-".join([group] * 4), "sk-helicone-eu-rl-" + "-".join([group] * 4),
                    "sk-" + "-".join([group] * 4), "sk-cp-gov-" + "-".join([group] * 4), "sk-sp-" + "0f" * 16,
                    "sk-build-bot-" + "Ab1_" * 15 + "T3BlbkFJ" + "Zx9-" * 15 + "Z"):
            with self.subTest(key=key[:12]):
                redacted, found = R.redact_secrets("Authorization: Bearer " + key + " end")
                self.assertEqual(redacted, "Authorization: Bearer [REDACTED_OPENAI_KEY] end")
                self.assertIn("secret:openai_key", [d["rule"] for d in found])

    def test_new_key_formats_skip_slugs_and_prose(self):
        for text in ("/blog/sk-cp-migration-guide-for-older-releases-2026", "sk-sp-summer-sale-landing-page-2026-final",
                     "sk-example-content-weather-another", "sk-abcdefg-hijklmn-opqrstu-vwxyzab",
                     "sk-a1b2c3d-a1b2c3d-a1b2c3d-a1b2c3d-next-page", "sk-eu-regional-pricing-table-update-2026",
                     "/blog/ask-helicone-how-to-route-requests-2026"):
            with self.subTest(text=text[:20]):
                self.assertEqual(R.redact_secrets(text)[1], [])

    def test_legacy_key_with_marker_keeps_its_suffix(self):
        key = "sk-" + "Qw3e" * 5 + "T3Blbk" + "FJ" + "Qw3e" * 5
        for suffix in ("_backup", "-old"):
            with self.subTest(suffix=suffix):
                self.assertEqual(R.redact_secrets("OPENAI_KEY=" + key + suffix)[0], "OPENAI_KEY=[REDACTED_OPENAI_KEY]" + suffix)

    def test_helicone_key_followed_by_a_suffix(self):
        groups = "-".join(["a1b2c3d"] * 4)
        for key in ("sk-helicone-" + groups, "sk-helicone-eu-rl-" + groups):
            for suffix in ("-old", "X", "_backup"):
                with self.subTest(key=key[:15], suffix=suffix):
                    self.assertEqual(R.redact_secrets(key + suffix)[0], "[REDACTED_OPENAI_KEY]" + suffix)
        # Without the word "helicone", a following "-<letter or digit>" reads as a longer slug.
        self.assertEqual(R.redact_secrets("sk-" + groups + "X")[0], "[REDACTED_OPENAI_KEY]X")
        self.assertEqual(R.redact_secrets("sk-" + groups + "-old")[1], [])

    def test_private_key_with_repeated_headers(self):
        body = "MII" + "Cd" * 30
        text = "-----BEGIN PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\n" + body + "\n-----END RSA PRIVATE KEY-----"
        redacted = R.redact_secrets(text)[0]
        self.assertNotIn(body, redacted)
        self.assertIn("[REDACTED_PRIVATE_KEY]", redacted)

    def test_case_folding_matches_nodejs(self):
        # Python's re folds the Kelvin sign, ſ and ı into ASCII letters
        # under IGNORECASE; the patterns use explicit [Aa] classes instead.
        value = "d4" * 8
        self.assertTrue(R.redact_secrets("KAPI_KEY=" + value)[1])
        self.assertEqual(R.redact_secrets("ſECRET_KEY=" + value)[1], [])
        self.assertEqual(R.redact_secrets("awſ_secret=" + "u" * 40)[1], [])

    def test_connection_string_schemes_use_ascii_letters(self):
        # Like Node.js, only ASCII letters spell a scheme name: a long s is not an s.
        for url in ("MYSQL://root:s3cretpw@127.0.0.1/shop", "Redis://default:r3dispw@cache:6379",
                    "mongodb+srv://svc:m0ngopw@cluster0.example.net/prod", "PostgreSQL://app:hunter2pass@db/app"):
            with self.subTest(url=url):
                redacted, found = R.redact_secrets(url)
                self.assertIn("[REDACTED_DB_PASSWORD]", redacted)
                self.assertIn("secret:db_url_password", [d["rule"] for d in found])
        for url in ("po\u017ftgres://app:hunter2pass@db/app", "my\u017fql://root:s3cretpw@127.0.0.1/shop",
                    "mongodb+\u017frv://svc:m0ngopw@cluster0.example.net/prod"):
            with self.subTest(url=ascii(url)):
                self.assertEqual(R.redact_secrets(url), (url, []))

    def test_aws_secret_keeps_quotes_in_both_engines(self):
        secret = "A" * 20 + "/" + "b" * 19
        out = R.redact_secrets('aws_secret_access_key = "' + secret + '"')[0]
        self.assertNotIn(secret, out)
        self.assertTrue(out.startswith('aws_secret_access_key = "') and out.endswith('"'), out)


if __name__ == "__main__":
    unittest.main()
