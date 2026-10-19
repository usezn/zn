"""Provider token formats: the Python redactor and the Node.js scrubber
(packages/zn-gate/lib/scrub/patterns.js) must agree on them.

Every case has a fake positive, built at runtime from parts, that both engines
redact or detect, and a near-miss negative that both leave alone. The Node side
runs findPatterns() in a subprocess; the checkout must be next to this package
and `node` must be installed, otherwise the test is skipped.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate import rules as R

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
PATTERNS_JS = NODE_PKG / "lib" / "scrub" / "patterns.js"

ALNUM = "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj0Ks"
B64 = ALNUM + "+/"
HEX = "0123456789abcdef"
UPPER_DIGIT = "QZ7K3LM9PW2NY5RB"


def _body(n, alphabet=ALNUM):
    """A machine-looking body of n characters (fake; cycles a fixed alphabet)."""
    return "".join(alphabet[i % len(alphabet)] for i in range(n))


# (rule id, Node type or None, positive, negative)
# Shuffled so that no body starts with a placeholder run such as "0123456789".
HX_ = "3a7f0c95e1b2d846"
LA_ = "qa7zt3lm9pw2ny5rb8vx1cd4fg6hj0ks"
UR_ = ALNUM + "-_"


def _uuid():
    return "-".join([_body(8, HX_), _body(4, HX_), _body(4, HX_), _body(4, HX_), _body(12, HX_)])


CASES = [
    ("secret:aws_key_id", "AWS_KEY", "ASIA" + _body(16, UPPER_DIGIT), "ASIA" + _body(15, UPPER_DIGIT)),
    ("secret:gitlab_token", "GITLAB_TOKEN", "glpat-" + _body(20), "glpat-" + _body(19)),
    ("secret:slack_token", "SLACK_TOKEN", "xoxb-" + "1234567890" + "-" + _body(16),
     "xoxb-" + "12345" + "-" + _body(16)),
    ("secret:slack_webhook", "SLACK_WEBHOOK", "https://hooks.slack.com/services/" + _body(24),
     "https://hooks.slack.com/services/" + _body(19)),
    ("secret:discord_webhook", "DISCORD_WEBHOOK", "https://discord.com/api/webhooks/" + "123456789012345678/" + _body(60),
     "https://discord.com/api/webhooks/" + "123456789012345678/" + _body(59)),
    ("secret:stripe_key", "STRIPE_KEY", "sk_live_" + _body(24), "sk_live_" + _body(19)),
    ("secret:stripe_webhook_secret", "STRIPE_WEBHOOK_SECRET", "whsec_" + _body(32), "whsec_" + _body(31)),
    ("secret:google_api_key", "GOOGLE_API_KEY", "AIza" + _body(35), "AIza" + _body(34)),
    ("secret:google_oauth_secret", "GOOGLE_OAUTH_SECRET", "GOCSPX-" + _body(28), "GOCSPX-" + _body(27)),
    ("secret:hf_token", "HF_TOKEN", "hf_" + _body(34), "hf_" + _body(33)),
    ("secret:npm_token", "NPM_TOKEN", "npm_" + _body(36), "npm_" + _body(35)),
    ("secret:pypi_token", "PYPI_TOKEN", "pypi-AgE" + _body(50), "pypi-AgE" + _body(49)),
    ("secret:sendgrid_key", "SENDGRID_KEY", "SG." + _body(22) + "." + _body(43), "SG." + _body(21) + "." + _body(43)),
    ("secret:twilio_key", "TWILIO_KEY", "SK" + HEX * 2, "SK" + (HEX * 2)[:31]),
    ("secret:mailgun_key", "MAILGUN_KEY", "key-" + HEX * 2, "key-" + (HEX * 2)[:31]),
    ("secret:shopify_token", "SHOPIFY_TOKEN", "shpat_" + HEX * 2, "shpat_" + (HEX * 2)[:31]),
    ("secret:digitalocean_token", "DIGITALOCEAN_TOKEN", "dop_v1_" + HEX * 4, "dop_v1_" + (HEX * 4)[:63]),
    ("secret:linear_key", "LINEAR_KEY", "lin_api_" + _body(40), "lin_api_" + _body(39)),
    ("secret:telegram_bot_token", "TELEGRAM_BOT_TOKEN", "123456789:AA" + _body(33), "123456789:AA" + _body(32)),
    ("secret:azure_storage_key", "AZURE_STORAGE_KEY", "AccountKey=" + _body(86, B64) + "==",
     "AccountKey=" + _body(85, B64) + "=="),
    ("secret:databricks_token", "DATABRICKS_TOKEN", "dapi" + HEX * 2, "dapi" + (HEX * 2)[:31]),
    ("secret:vault_token", "VAULT_TOKEN", "hvs." + _body(24), "hvs." + _body(23)),
    ("secret:doppler_token", "DOPPLER_TOKEN", "dp.st." + _body(40), "dp.st." + _body(39)),
    ("secret:newrelic_key", "NEWRELIC_KEY", "NRAK-" + UPPER_DIGIT + UPPER_DIGIT[:11],
     "NRAK-" + UPPER_DIGIT + UPPER_DIGIT[:10]),
    ("secret:groq_key", "GROQ_KEY", "gsk_" + _body(52), "gsk_" + _body(51)),
    ("secret:xai_key", "XAI_KEY", "xai-" + _body(80), "xai-" + _body(79)),
    ("secret:dockerhub_pat", "DOCKERHUB_PAT", "dckr_pat_" + _body(24), "dckr_pat_" + _body(19)),
    ("secret:tavily_key", "TAVILY_KEY", "tvly-" + _body(22), "tvly-" + _body(19)),
    ("secret:firecrawl_key", "FIRECRAWL_KEY", "fc-" + _body(24), "fc-" + _body(19)),
    ("secret:polar_token", "POLAR_TOKEN", "polar_oat_" + _body(24), "polar_oat_" + _body(19)),
    ("secret:replicate_token", "REPLICATE_TOKEN", "r8_" + _body(37), "r8_" + _body(36)),
    ("secret:supabase_pat", "SUPABASE_PAT", "sbp_" + _body(32), "sbp_" + _body(29)),
    ("secret:square_token", "SQUARE_TOKEN", "EAAA" + _body(60), "EAAA" + _body(59)),
    ("secret:square_token", "SQUARE_TOKEN", "sq0csp-" + _body(43), "sq0csp-" + _body(42)),
    ("secret:discord_bot_token", "DISCORD_BOT_TOKEN", "MTIzNDU2Nzg5MDEyMzQ1Njc4." + _body(6) + "." + _body(30),
     "MQa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4." + _body(6) + "." + _body(30)),
    ("secret:discord_bot_token", "DISCORD_BOT_TOKEN", "MTIzNDU2Nzg5MDEyMzQ1Njc." + _body(6) + "." + _body(27),
     "MTIzNDU2Nzg5MDEyMzQ1Njc." + _body(6) + "." + _body(26)),
    ("secret:discord_bot_token", "DISCORD_BOT_TOKEN", "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA." + _body(6) + "." + _body(38),
     "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA." + _body(5) + "." + _body(38)),
    ("secret:onepassword_sa_token", "ONEPASSWORD_SA_TOKEN", 'ops_eyJ' + _body(250, B64),
     'ops_eyJ' + _body(249, B64)),
    ("secret:age_secret_key", "AGE_SECRET_KEY", 'AGE-SECRET-KEY-1' + _body(58, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'),
     'AGE-SECRET-KEY-1' + _body(57, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L')),
    ("secret:alibaba_key_id", "ALIBABA_KEY_ID", 'LTAI' + _body(20),
     'LTAI' + _body(19)),
    ("secret:artifactory_key", "ARTIFACTORY_KEY", 'AKCp' + _body(69),
     'AKCp' + _body(68)),
    ("secret:cloudflare_origin_ca_key", "CLOUDFLARE_ORIGIN_CA_KEY", 'v1.0-' + _body(24, HX_) + '-' + _body(146, HX_),
     'v1.0-' + _body(24, HX_) + '-' + _body(145, HX_)),
    ("secret:dynatrace_token", "DYNATRACE_TOKEN", 'dt0c01.' + _body(24) + '.' + _body(64),
     'dt0c01.' + _body(23) + '.' + _body(64)),
    ("secret:easypost_key", "EASYPOST_KEY", 'EZAK' + _body(54),
     'EZAK' + _body(53)),
    ("secret:flyio_token", "FLYIO_TOKEN", 'fo1_' + _body(43, UR_),
     'fo1_' + _body(42, UR_)),
    ("secret:grafana_token", "GRAFANA_TOKEN", 'glsa_' + _body(32) + '_' + _body(8, HX_),
     'glsa_' + _body(31) + '_' + _body(8, HX_)),
    ("secret:terraform_cloud_token", "TERRAFORM_CLOUD_TOKEN", _body(14, LA_) + '.atlasv1.' + _body(64, UR_),
     _body(14, LA_) + '.atlasv1.' + _body(59, UR_)),
    ("secret:heroku_key_v2", "HEROKU_KEY_V2", 'HRKU-AA' + _body(58, UR_),
     'HRKU-AA' + _body(57, UR_)),
    ("secret:notion_token", "NOTION_TOKEN", 'ntn_' + _body(11, '0123456789') + _body(35),
     'ntn_' + _body(11, '0123456789') + _body(34)),
    ("secret:perplexity_key", "PERPLEXITY_KEY", 'pplx-' + _body(48),
     'pplx-' + _body(47)),
    ("secret:planetscale_token", "PLANETSCALE_TOKEN", 'pscale_tkn_' + _body(40, UR_),
     'pscale_tkn_' + _body(31, UR_)),
    ("secret:postman_key", "POSTMAN_KEY", 'PMAK-' + _body(24, HX_) + '-' + _body(34, HX_),
     'PMAK-' + _body(24, HX_) + '-' + _body(33, HX_)),
    ("secret:prefect_key", "PREFECT_KEY", 'pnu_' + _body(36),
     'pnu_' + _body(35)),
    ("secret:pulumi_token", "PULUMI_TOKEN", 'pul-' + _body(40, HX_),
     'pul-' + _body(39, HX_)),
    ("secret:readme_key", "README_KEY", 'rdme_' + _body(70, LA_),
     'rdme_' + _body(69, LA_)),
    ("secret:rubygems_key", "RUBYGEMS_KEY", 'rubygems_' + _body(48, HX_),
     'rubygems_' + _body(47, HX_)),
    ("secret:brevo_key", "BREVO_KEY", 'xkeysib-' + _body(64, HX_) + '-' + _body(16),
     'xkeysib-' + _body(64, HX_) + '-' + _body(15)),
    ("secret:sentry_user_token", "SENTRY_USER_TOKEN", 'sntryu_' + _body(64, HX_),
     'sntryu_' + _body(63, HX_)),
    ("secret:shippo_key", "SHIPPO_KEY", 'shippo_live_' + _body(40, HX_),
     'shippo_live_' + _body(39, HX_)),
    ("secret:openshift_token", "OPENSHIFT_TOKEN", 'sha256~' + _body(43, UR_),
     'sha256~' + _body(42, UR_)),
    ("secret:teams_webhook", "TEAMS_WEBHOOK", 'https://example.webhook.office.com/webhookb2/' + _uuid() + '@' + _uuid() + '/IncomingWebhook/' + _body(32, HX_) + '/' + _uuid(),
     'https://example.webhook.office.com/webhookb2/' + _uuid() + '@' + _uuid() + '/IncomingWebhook/' + _body(31, HX_) + '/' + _uuid()),
    ("secret:flyio_token", "FLYIO_TOKEN", 'fm1a_' + _body(100, B64), 'fm1a_' + _body(99, B64)),
    ("secret:flyio_token", "FLYIO_TOKEN", 'fm1r_' + _body(120, B64) + '==', 'fm1r_' + _body(99, B64)),
    ("secret:flyio_token", "FLYIO_TOKEN", 'fm2_' + _body(100, B64), 'fm2_' + _body(99, B64)),
    ("secret:grafana_token", "GRAFANA_TOKEN", 'glc_' + _body(32, B64), 'glc_' + _body(31, B64)),
    ("secret:easypost_key", "EASYPOST_KEY", 'EZTK' + _body(54), 'EZTK' + _body(53)),
    ("secret:planetscale_token", "PLANETSCALE_TOKEN", 'pscale_oauth_' + _body(40, UR_), 'pscale_oauth_' + _body(31, UR_)),
    ("secret:planetscale_token", "PLANETSCALE_TOKEN", 'pscale_pw_' + _body(40, UR_), 'pscale_pw_' + _body(31, UR_)),
    ("secret:shippo_key", "SHIPPO_KEY", 'shippo_test_' + _body(40, HX_), 'shippo_test_' + _body(39, HX_)),
    ("secret:postman_key", "POSTMAN_KEY", 'PMAK-' + _body(24, HX_).upper() + '-' + _body(34, HX_).upper(),
     'PMAK-' + _body(24, HX_).upper() + '-' + _body(33, HX_).upper()),
    # one character too many, and a prefix glued to a longer word
    ("secret:alibaba_key_id", "ALIBABA_KEY_ID", 'key LTAI' + _body(20) + ' end', 'key LTAI' + _body(21) + ' end'),
    ("secret:alibaba_key_id", "ALIBABA_KEY_ID", 'id=LTAI' + _body(20), 'id=xLTAI' + _body(20)),
    ("secret:pulumi_token", "PULUMI_TOKEN", 'pul-' + _body(40, HX_), 'pul-' + _body(41, HX_)),
    ("secret:azure_ad_client_secret", "AZURE_AD_CLIENT_SECRET", "abc1Q~" + _body(33), "abc1Q~" + _body(29)),
    ("secret:url_password", "URL_PASSWORD", "https://svc-user:Zq8Lm2Xv9Pt4@files.test/path",
     "https://svc-user:Zq8@files.test/path"),
    ("secret:bearer_token", None, "Authorization: Bearer " + _body(32),
     "Authorization: Bearer __ZN_GITHUB_TOKEN__"),
]


def _node_types(texts):
    """Node findPatterns() types for each text, one subprocess for the batch."""
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed: skipping the provider parity check")
    if not PATTERNS_JS.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the provider parity check")
    script = (
        "const p = require(process.argv[1]); let d = '';"
        "process.stdin.on('data', (c) => { d += c; }).on('end', () => {"
        " const out = JSON.parse(d).map((t) => p.findPatterns(t).map((s) => s.type));"
        " process.stdout.write(JSON.stringify(out)); });"
    )
    # Run from an empty directory so no .znrules / zn.config.json is picked up.
    with tempfile.TemporaryDirectory() as cwd:
        proc = subprocess.run(
            [node, "-e", script, str(PATTERNS_JS)],
            input=json.dumps(texts).encode("utf-8"), cwd=cwd,
            capture_output=True, timeout=120, check=True,
        )
    return json.loads(proc.stdout.decode("utf-8"))


class TestProviderFormatsParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        texts = []
        for _, _, pos, neg in CASES:
            texts.extend([pos, neg])
        cls.node = _node_types(texts)

    def test_rule_ids_are_unique_and_outside_the_shared_table(self):
        ids = [rule_id for rule_id, _, _ in R.PROVIDER_SECRET_PATTERNS]
        self.assertEqual(len(ids), len(set(ids)))
        shared = {rule_id for rule_id, _, _ in R.SECRET_PATTERNS}
        self.assertFalse(shared & set(ids))

    def test_positives_are_redacted_by_python_and_detected_by_node(self):
        for i, (rule_id, node_type, pos, _) in enumerate(CASES):
            with self.subTest(rule=rule_id):
                redacted, found = R.redact_secrets(pos)
                self.assertIn(rule_id, [d["rule"] for d in found])
                self.assertNotIn(pos, redacted)
                self.assertIn("[REDACTED_", redacted)
                if node_type is not None:
                    self.assertIn(node_type, self.node[2 * i])

    def test_near_misses_are_left_alone_by_python_and_node(self):
        for i, (rule_id, node_type, _, neg) in enumerate(CASES):
            with self.subTest(rule=rule_id):
                redacted, found = R.redact_secrets(neg)
                self.assertEqual(redacted, neg)
                self.assertEqual(found, [])
                # Node's generic SECRET rule may still fire on a keyword assignment; the provider type must not.
                if node_type is None:
                    self.assertEqual(self.node[2 * i + 1], [])
                else:
                    self.assertNotIn(node_type, self.node[2 * i + 1])

    def test_placeholder_bodies_are_not_tokens(self):
        cases = [
            ("secret:prefect_key", "PREFECT_KEY", 'pnu_' + '0' * 36),
            ("secret:pulumi_token", "PULUMI_TOKEN", 'pul-' + 'a' * 40),
            ("secret:pulumi_token", "PULUMI_TOKEN", 'pul-' + ('0123456789abcdef' * 3)[:40]),
            ("secret:openshift_token", "OPENSHIFT_TOKEN", 'sha256~' + 'x' * 43),
            ("secret:openshift_token", "OPENSHIFT_TOKEN", 'sha256~abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'),
            ("secret:alibaba_key_id", "ALIBABA_KEY_ID", 'LTAI' + 'X' * 20),
            ("secret:alibaba_key_id", "ALIBABA_KEY_ID", 'LTAIabcdefghijKLMNOP1234'),
        ]
        node = _node_types([t for _, _, t in cases])
        for (rule_id, node_type, text), types in zip(cases, node, strict=False):
            with self.subTest(text=text):
                _, found = R.redact_secrets(text)
                self.assertNotIn(rule_id, [d["rule"] for d in found])
                self.assertNotIn(node_type, types)

    def test_every_provider_rule_has_a_case(self):
        covered = {rule_id for rule_id, _, _, _ in CASES}
        self.assertEqual(covered, {rule_id for rule_id, _, _ in R.PROVIDER_SECRET_PATTERNS})


if __name__ == "__main__":
    unittest.main()
