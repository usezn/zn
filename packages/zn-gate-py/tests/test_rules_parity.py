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
import time
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

    def test_advisory_by_default_list(self):
        self.assertEqual(sorted(R.ADVISORY_BY_DEFAULT), self.js["advisory_by_default"])

    def test_exfil_compound(self):
        (rule,) = self.js["exfil"]
        self.assertEqual(rule["id"], "exfil:credentials")
        self.assertEqual([_py_regex(R.EXFIL_VERBS), _py_regex(R.CRED_OBJECTS), _py_regex(R.EXFIL_CLAUSE_RE)],
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
        self.assertEqual({k: _py_regex(v) for k, v in R.SECRET_PATTERN_PREFILTERS.items()},
                         {k: _js_regex(e) for k, e in self.js["secret_prefilters"].items()})

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
        for text in ("x" + "AKIA" + "Z" * 16, "AKIA" + "Z" * 16 + "_x", "my_" + "api_key=" + "d4" * 8):
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


# Synthetic values, built from pieces so that no complete credential appears in the source.
RANDOM_24 = "Zx9" + "kQ2mN8pL" + "4rT6vW1y" + "Hc5J0"
RANDOM_40 = "aB3dE5fG7h" + "J9kL2mN4pQ" + "6rS8tU0vW1" + "xY3zA5bC7d"


class TestPrefixedCredentialNames(unittest.TestCase):
    """Credential assignments under environment-style names: secrets are
    redacted; references, code and placeholders are not."""

    def assertRedacted(self, text, value):
        redacted, found = R.redact_secrets(text)
        self.assertNotIn(value, redacted, text)
        self.assertTrue(found, text)

    def assertKept(self, text):
        self.assertEqual(R.redact_secrets(text), (text, []), text)

    def test_prefixed_names_are_redacted(self):
        value = "Kp4r" * 5
        for name in ("OPENAI_API_KEY", "STRIPE_SECRET_KEY", "GITHUB_AUTH_TOKEN", "MY_API_KEY",
                     "PROD_AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "APP_SECRET", "SLACK_BOT_TOKEN"):
            for sep in ("=", ": ", " = ", '="'):
                with self.subTest(name=name, sep=sep):
                    self.assertRedacted(name + sep + value, value)

    def test_more_names_json_and_dockerfile(self):
        value = "Zx9" + "kQ" * 10
        for text in ('"OPENAI_API_KEY": "' + value + '"', "'DB_PASSWORD': '" + value + "'",
                     "SENDGRID_APIKEY=" + value, "MAILGUN_ACCESS_KEY=" + value, "POSTGRES_PASS=" + value,
                     "REDIS_PWD=" + value, "REDIS_PASSWD=" + value, "GCP_CREDENTIALS=" + value,
                     "ENV HF_TOKEN " + value, "ENV STRIPE_SECRET_KEY=" + value,
                     "ENV NODE_ENV=production VAULT_SECRET=" + value, '{"api_key": "' + value + '"}'):
            with self.subTest(text=text[:24]):
                self.assertRedacted(text, value)

    def test_dollar_assignments_in_php_and_powershell(self):
        for text in ("$API_KEY = '" + RANDOM_24 + "';", "$OPENAI_API_KEY = '" + RANDOM_24 + "';",
                     "$env:DEPLOY_TOKEN = \"" + RANDOM_24 + "\"", "$env:API_KEY=\"" + RANDOM_24 + "\""):
            with self.subTest(text=text[:20]):
                self.assertRedacted(text, RANDOM_24)
        # "$NAME:" is a shell reference followed by text, and "${NAME}" a reference.
        for text in ("echo $DB_PASSWORD:" + "x7" * 8, "echo ${DB_PASSWORD}" + "x7" * 8,
                     'URL="https://$API_TOKEN:' + "x7" * 8 + '@example.com"'):
            with self.subTest(text=text[:20]):
                self.assertEqual(R.redact_secrets(text)[1], [])

    def test_machine_generated_values_with_code_like_shapes(self):
        cases = {
            "mapbox": "MAPBOX_SECRET_TOKEN=sk.eyJ1Ijoi" + "Zm9vYmFy" * 4 + "In0." + "QwErTy12" + "AsDfGh34Zx",
            "sendgrid": "SENDGRID_API_KEY=SG." + "Ab3cD4eF5gH6iJ7kL8mN9q" + "." + "pQ1r" * 10 + "sT2",
            "doppler": "DOPPLER_TOKEN=dp.st.prd." + RANDOM_40,
            "vault": "VAULT_TOKEN=hvs." + RANDOM_24,
            "django": "SECRET_KEY = '" + "k9(x#2_q" * 6 + "'",
            "mailgun": "MAILGUN_API_KEY=key-" + "a1b2c3d4" * 4,
            "app_password": "SMTP_PASSWORD=" + "wxyz-" * 3 + "abcd",
            "brackets": "DB_PASSWORD=Tr0(b4)[x]{9}" + "Qz" * 2,
            "word_parens": "DB_PASSWORD=Maple(River)" + "StoneCopper",
            "dashed_words": "api_key: " + "orbit-maple-" + "harbor-cinder",
            "dotted_words": "APP_PASSPHRASE_SECRET=" + "orbit.maple." + "harbor.cinder",
            "base64_slash": "AWS_BACKUP_SECRET_ACCESS_KEY=/" + RANDOM_40[:39],
            "url_password": "BROKER_PASSWORD=amqps://app:" + RANDOM_24 + "@mq.internal/vh",
        }
        for name, text in cases.items():
            with self.subTest(case=name):
                sep = "=" if "=" in text.split(" ")[0] else (" = " if " = " in text else ": ")
                value = text.split(sep, 1)[1].strip("'")
                self.assertRedacted(text, value)

    def test_code_is_left_alone(self):
        for text in ("const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;",
                     "  OPENAI_API_KEY: process.env.OPENAI_API_KEY,", "  OPENAI_API_KEY: z.string().min(1),",
                     'DB_PASSWORD = os.environ.get("DB_PASSWORD")', 'API_KEY = os.getenv("API_KEY")',
                     "SLACK_BOT_TOKEN = settings.SLACK_BOT_TOKEN", "GH_TOKEN: core.getInput('token')",
                     "K8S_TOKEN = settings.K8S_TOKEN", "R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,",
                     "SESSION_SECRET = os.urandom(32).hex()", "JWT_SECRET = crypto.randomBytes(64).toString('hex')",
                     "DB_PASSWORD = Secret.fromSecretNameV2(this, 'db')", 'let API_TOKEN = std::env::var("API_TOKEN")?;',
                     "STRIPE_API_KEY = Rails.application.credentials.stripe", "GITHUB_TOKEN = secrets.GITHUB_TOKEN",
                     "OPENAI_API_KEY = FAKE.apiKey,", "DB_PASSWORD = random_password.db.result",
                     "API_TOKEN: Optional[str] = None", 'AWS_TOKEN_HEADER = "x-aws-ec2-metadata-token"',
                     "QUIDOR_APIKEY = DEFAULT_RANSUFI_APIKEY", "TAVSU_ACCESS_KEY = secrets.token_urlsafe(48)",
                     "api_key: @user.api_key", "private_key: (Some(local_site.private_key)),"):
            with self.subTest(text=text[:40]):
                self.assertKept(text)

    def test_references_and_placeholders_are_left_alone(self):
        for text in ("GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}", "SERVICE_PASSWORD=${SERVICE_PASSWORD}",
                     "DEPLOY_TOKEN=$DEPLOY_TOKEN_FROM_CI", "OPENAI_API_KEY=<your-openai-key>",
                     "WIN_SECRET=%WINDOWS_SECRET_VAR%", "API_KEY=$(openssl rand -base64 32)",
                     "GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json",
                     "GOOGLE_APPLICATION_CREDENTIALS=.secrets/service-account.json",
                     "APP_PRIVATE_KEY=./keys/private.pem", "GH_TOKEN=~/.config/gh/hosts.yml",
                     "SSL_PRIVATE_KEY=C:\\certs\\server.key", "OPENAI_API_KEY=op://Private/OpenAI/credential",
                     "DB_PASSWORD=sm://projects/demo/secrets/db/versions/latest",
                     "DB_PASSWORD=arn:aws:secretsmanager:us-east-1:000000000000:secret:prod/db",
                     "DB_PASSWORD=vault:secret/data/app#password", "API_TOKEN=secretref:app-secrets/api-token",
                     "API_KEY=@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/k/)",
                     "API_KEY=projects/demo/secrets/api-key/versions/3", "BROKER_PASSWORD=amqps://mq.internal/vh",
                     "BROKER_PASSWORD=amqps://app:${MQ_PASS}@mq.internal/vh",
                     "OPENAI_API_KEY=your-openai-api-key-here", "STRIPE_SECRET_KEY=" + "x" * 24,
                     "STRIPE_SECRET_KEY=sk_live_" + "x" * 24, "APP_SECRET=REPLACE_ME_WITH_REAL", "MY_API_KEY=placeholder-value-123",
                     "SECRET_KEY=please-change-this-value", "API_TOKEN=not-set-in-dev", "JWT_SECRET=set-me-in-production",
                     "API_TOKEN=fake-token-for-tests", "PROVIDER_API_KEY=mock-provider-key",
                     "SECRET_KEY=00000000-0000-0000-0000-000000000000", 'AUTH_TOKEN: "************************"',
                     "DB_PASSWORD=__ZN_DB_PASSWORD__", "SERVICE_API_KEY=zn_live_your_key",
                     "aws_secret_access_key: 'fakeSecretKey'"):
            with self.subTest(text=text[:40]):
                self.assertKept(text)

    def test_compose_defaults_are_redacted_only_when_generated(self):
        for text in ("POSTGRES_PASSWORD: ${DB_PASSWORD:-difyai123456}",
                     "MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}",
                     "SECRET_KEY: ${SECRET_KEY:-change-me-in-production}", 'API_TOKEN: "${API_TOKEN:?set API_TOKEN}"'):
            with self.subTest(text=text[:30]):
                self.assertKept(text)
        redacted, found = R.redact_secrets("JWT_SECRET: ${JWT_SECRET:-" + RANDOM_24 + "}")
        self.assertEqual(redacted, "JWT_SECRET: ${JWT_SECRET:-[REDACTED_SECRET]}")
        self.assertEqual([d["rule"] for d in found], ["secret:credential_default"])

    def test_generated_values_with_placeholder_marks_are_redacted(self):
        # A password manager may produce "<", "{{", "${", "***" or a leading "[".
        for value in ("<" + RANDOM_24 + "!#", "[" + RANDOM_24 + "%&", "{" + RANDOM_24 + "@=",
                      RANDOM_24[:10] + "<a>" + RANDOM_24[10:] + "#", RANDOM_24 + "${" + "Q9!",
                      RANDOM_24[:8] + "{{" + RANDOM_24[8:] + "^", RANDOM_24 + "***" + "7!", RANDOM_24 + "..." + "7!"):
            for name in ("API_KEY", "STRIPE_SECRET_KEY"):
                with self.subTest(name=name, value=value[:6]):
                    self.assertRedacted(name + '="' + value + '"', value)
        for text in ("API_KEY=sk-proj-****", "API_KEY=<your-key-here>", "API_KEY=${VAR_NAME_HERE}",
                     "API_KEY={{ .Values.apiKey }}", "API_KEY=[REDACTED_BY_CI]", "API_KEY=" + "*" * 16):
            with self.subTest(text=text):
                self.assertKept(text)

    def test_object_names_files_and_hosts_are_left_alone(self):
        for text in ("IMAGE_PULL_SECRET=regcred-ghcr", "TLS_SECRET: ingress-nginx-tls",
                     "GOOGLE_APPLICATION_CREDENTIALS=service-account.json", "FIREBASE_CREDENTIALS=firebase-adminsdk.json",
                     "KEYSTORE_PASSWORD=android-release.keystore", "SMTP_PASSWORD=smtp.sendgrid.net",
                     "HELM_REPO_PASSWORD=bitnami-charts", "GH_TOKEN=github-actions-bot", "X_PASSWORD=ask-the-ops-team",
                     "X_PASSWORD=get-from-bitwarden", "api_key: preview-does-not-require-setup", "APP_TOKEN=xx-aaaaaaaaaaaa"):
            with self.subTest(text=text):
                self.assertKept(text)
        for text in ("DB_PASSWORD=orbit-maple-harbor", "JWT_SECRET=orbit-maple-harbor-cinder", "SMTP_PASSWORD=wxyz-wxyz-wxyz-abcd"):
            with self.subTest(text=text):
                self.assertRedacted(text, text.split("=", 1)[1])

    def test_php_perl_and_powershell_references(self):
        for text in ("$API_KEY = $this->config->get('api_key');", "$DB_PASSWORD = $container->getParameter('db');",
                     "my $API_TOKEN = $config->{api_token};", "$env:GITHUB_TOKEN = $env:GITHUB_TOKEN_PROD"):
            with self.subTest(text=text[:24]):
                self.assertKept(text)

    def test_reference_shapes_with_random_content_are_redacted(self):
        inner = RANDOM_24[:15]
        for value in ("!" + inner, "@" + inner + "@", "[" + inner + "]", "$" + inner, "%" + inner + "%", "$env:" + inner):
            with self.subTest(value=value[:3]):
                self.assertRedacted("API_KEY=" + value, value)
        for text in ("X_SECRET: !ImportValue", "X_SECRET: !Ref", "X_TOKEN: $$X_TOKEN_VAR", "X_PASSWORD=@app.x_password@",
                     "DEPLOY_TOKEN=$DEPLOY_TOKEN_FROM_CI", "API_KEY=[YOUR_API_KEY_HERE]", "WIN_SECRET=%WINDOWS_SECRET_VAR%"):
            with self.subTest(text=text):
                self.assertKept(text)

    def test_lone_surrogates_do_not_raise(self):
        for text in ("API_TOKEN=" + "abc123XYZ09" + "\ud800", "API_KEY=" + RANDOM_24 + "\udfff",
                     "${API_TOKEN:-" + RANDOM_24 + "\ud800}", "X_SECRET=\ud800" + "Kp4r" * 4):
            with self.subTest(text=ascii(text)[:24]):
                R.redact_secrets(text)
                R.sanitize_tool_result(text)

    def test_documented_limits(self):
        # Lower-case words joined by "_" read as an identifier, and values under 12 characters are not checked.
        for text in ("DB_PASSWORD=" + "orbit_maple_" + "harbor_cinder", "DB_PASSWORD=hunter2xyz", "db_password: " + RANDOM_24):
            with self.subTest(text=text[:20]):
                self.assertKept(text)

    def test_value_checks_are_bounded_per_call(self):
        line = "SERVICE_TOKEN=process.env.SERVICE_TOKEN_VALUE"
        lines = R.redact_secrets("\n".join([line] * (R.MAX_FILTERED_CHARS // 31 + 50)))[0].split("\n")
        self.assertEqual(lines[0], line)
        self.assertEqual(lines[-1], "SERVICE_TOKEN=[REDACTED_SECRET]")

    def test_trailing_separators_are_linear(self):
        for text in ("A_TOKEN=" + ";" * 200000, "API_KEY=" + "," * 200000, "A_TOKEN=a" + ";" * 200000):
            start = time.process_time()
            R.redact_secrets(text)
            self.assertLess(time.process_time() - start, 5.0)


if __name__ == "__main__":
    unittest.main()
