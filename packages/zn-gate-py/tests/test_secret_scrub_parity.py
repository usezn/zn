"""The Node.js scrubber (lib/scrub/patterns.js) and the Python redact_secrets name the same secrets.

A corpus of fake provider tokens, built here from a seeded generator (a public prefix and a random
body, never a real credential), is read by both engines: Python here, the Node.js pattern layer through
packages/zn-gate/test/helpers/export_scrub_spans.js. For every case the set of (type, start, end) must
be the same, apart from the cases listed in ALLOWED, each with its reason. A case in ALLOWED must still
differ, so the list cannot go stale. These tests need the monorepo checkout and a `node` binary; they
are skipped with a message when either is missing (for example when testing an sdist).

How the two sides are compared:
  * A Node.js type is the upper-case Python rule name (secret:stripe_key -> STRIPE_KEY), except the
    families in FAMILY: Python has one rule where Node.js has two (github_token, url_password...).
  * For the rules whose Python match includes the text around the secret (the key name, the scheme and
    user of a URL), the Node.js span must lie inside the Python one (WIDE); every other span is equal.
  * The generic SECRET type (a sensitive name with a value) is not compared: the two engines read
    different forms of it and their own tests cover each one.
"""

import json
import random
import re
import shutil
import subprocess
import tempfile
import unittest
from base64 import b64encode
from pathlib import Path

from zn_gate import rules as R
from zn_gate.rules import redact_secrets

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
EXPORT_SCRIPT = NODE_PKG / "test" / "helpers" / "export_scrub_spans.js"
PATTERNS_JS = NODE_PKG / "lib" / "scrub" / "patterns.js"

# One Python rule for two Node.js types (or two Python rules for one Node.js type).
FAMILY = {
    "aws_access_key": "AWS_KEY", "aws_key_id": "AWS_KEY",
    "github_token": "GITHUB_TOKEN", "GITHUB_PAT": "GITHUB_TOKEN",
    "aws_secret_key": "AWS_SECRET", "jwt_token": "JWT",
    "url_password": "URL_PASSWORD", "db_url_password": "URL_PASSWORD", "DB_PASSWORD": "URL_PASSWORD",
}
# Python rules that Node.js reads as the generic SECRET type: not compared.
GENERIC = {"env_credential", "prefixed_credential", "credential_default", "credential_assignment",
           "cli_credential_flag"}
# The Python match includes the key name, the scheme or the header name around the secret.
WIDE = {"AWS_SECRET", "URL_PASSWORD", "BEARER_TOKEN", "AZURE_STORAGE_KEY"}

rnd = random.Random(20261030)
ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
LOWER_DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789"
HEX = "0123456789abcdef"
UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
URLSAFE = ALNUM + "_-"
B64 = ALNUM + "+/"
DIGITS = "0123456789"


def r(n, alphabet=ALNUM):
    return "".join(rnd.choice(alphabet) for _ in range(n))


CASES = []


def case(label, text):
    CASES.append((label, text))


def tok(label, value):
    """A token on its own after a label, as in a log or an .env value."""
    case(label, "value: " + value + "\n")


# Anthropic
tok("anthropic api03 40", "sk-ant-" + "api03-" + r(40, URLSAFE))
tok("anthropic admin01 32", "sk-ant-" + "admin01-" + r(32, URLSAFE))
tok("anthropic masked body", "sk-ant-" + "api03-" + "x" * 40)
tok("anthropic 30 without shape", "sk-ant-" + r(30, URLSAFE))
# OpenAI
tok("openai proj", "sk-" + "proj-" + r(60, URLSAFE))
tok("openai svcacct", "sk-" + "svcacct-" + r(40, URLSAFE))
tok("openai or-v1", "sk-" + "or-v1-" + r(64, HEX))
tok("openai plain 48", "sk-" + r(48))
tok("openai plain 28", "sk-" + r(28))
tok("openai hex 32", "sk-" + r(32, HEX))
tok("openai hyphenated body 40+", "sk-" + "test-" + r(8) + "-" + r(30))
tok("openai underscored body 40+", "sk-" + r(20) + "_" + r(25))
tok("openai T3Blb marker", "sk-" + r(20) + "T3Blb" + "kFJ" + r(20))
tok("openai low entropy 48", "sk-" + "a" * 48)
# AWS
for pre in ("AKIA", "ASIA", "ABIA", "ACCA"):
    tok("aws key id " + pre, pre + r(16, UPPER))
tok("aws key id repeated body", "AKIA" + "A" * 16)
case("aws secret assignment", "aws_secret_access_key = " + r(40, B64) + "\n")
case("aws secret env upper quoted", 'AWS_SECRET_ACCESS_KEY="' + r(40, B64) + '"\n')
case("aws secret CLI json", '"SecretAccessKey": "' + r(40, B64) + '"\n')
case("aws secret in prose", "the secret access key is " + r(40, B64) + " for the account\n")
# GitHub
for pre in ("ghp_", "gho_", "ghu_", "ghs_", "ghr_"):
    tok("github " + pre + " 36", pre + r(36))
tok("github ghp 40", "ghp_" + r(40))
tok("github ghp 80", "ghp_" + r(80))
tok("github ghp low entropy", "ghp_" + "a" * 36)
tok("github fine-grained 22+59", "github_pat_" + r(22) + "_" + r(59))
tok("github fine-grained 22+70", "github_pat_" + r(22) + "_" + r(70))
tok("github fine-grained 82 with underscores", "github_pat_" + r(40, ALNUM + "_") + r(42, ALNUM + "_"))
# GitLab, Slack, webhooks
for pre in ("glpat-", "gldt-", "glrt-", "glptt-", "glcbt-", "glft-", "glsoat-"):
    tok("gitlab " + pre, pre + r(26, URLSAFE))
tok("slack xoxb", "xox" + "b-" + r(11, DIGITS) + "-" + r(12, DIGITS) + "-" + r(24))
tok("slack xoxp", "xox" + "p-" + r(11, DIGITS) + "-" + r(12, DIGITS) + "-" + r(24))
tok("slack xapp", "xap" + "p-1-" + r(10, UPPER) + "-" + r(11, DIGITS) + "-" + r(40, HEX))
tok("slack webhook", "https://hooks." + "slack.com/services/T" + r(8, UPPER) + "/B" + r(8, UPPER) + "/" + r(24))
tok("discord webhook", "https://discord." + "com/api/webhooks/" + r(18, DIGITS) + "/" + r(68, URLSAFE))
# Payment, Google, registries
tok("stripe sk live", "sk_" + "live_" + r(24))
tok("stripe rk test", "rk_" + "test_" + r(30))
tok("stripe prod 60", "sk_" + "prod_" + r(60))
tok("stripe webhook secret", "whsec" + "_" + r(40, B64))
tok("google api key", "AI" + "za" + r(35, URLSAFE))
tok("google oauth secret", "GOCS" + "PX-" + r(28, URLSAFE))
tok("huggingface 34 letters", "hf" + "_" + r(34, LETTERS))
tok("huggingface 34 mixed", "hf" + "_" + r(34))
tok("huggingface 40", "hf" + "_" + r(40))
tok("huggingface identifier-like", "hf" + "_" + "ModelForSequenceClassificationHead"[:34])
tok("npm", "npm" + "_" + r(36))
tok("pypi", "pypi" + "-AgE" + r(60, URLSAFE))
tok("sendgrid", "SG" + "." + r(22, URLSAFE) + "." + r(43, URLSAFE))
tok("twilio lower", "S" + "K" + r(31, HEX) + "a")
tok("twilio upper", "S" + "K" + r(31, "0123456789ABCDEF") + "A")
tok("mailgun", "key" + "-" + r(31, HEX) + "a")
tok("shopify", "shp" + "at_" + r(31, HEX) + "a")
tok("digitalocean", "dop" + "_v1_" + r(63, HEX) + "a")
tok("linear", "lin" + "_api_" + r(40))
tok("telegram", r(9, DIGITS) + ":AA" + r(33, URLSAFE))
tok("azure storage key", "AccountKey=" + r(86, B64) + "==")
tok("databricks", "dap" + "i" + r(31, HEX) + "a")
tok("databricks with suffix", "dap" + "i" + r(31, HEX) + "a-3")
tok("vault", "hv" + "s." + r(26, URLSAFE))
tok("doppler", "dp" + ".pt." + r(43, URLSAFE))
tok("newrelic", "NR" + "AK-" + r(27, UPPER))
tok("groq", "gsk" + "_" + r(52))
tok("xai", "xai" + "-" + r(80))
tok("dockerhub", "dckr" + "_pat_" + r(27, URLSAFE))
tok("zn api key", "zn" + "_" + r(47, HEX) + "a")
tok("tavily", "tvly" + "-" + r(10) + "7" + r(13))
tok("firecrawl", "fc" + "-" + r(10) + "7" + r(13))
tok("polar oat", "polar" + "_oat_" + r(30, URLSAFE))
tok("polar rt", "polar" + "_rt_u_" + r(30, URLSAFE))
tok("replicate", "r8" + "_" + r(37))
tok("supabase", "sbp" + "_" + r(10) + "7" + r(29))
tok("square EAAA", "EAAA" + r(60, URLSAFE))
tok("square legacy access", "sq0" + "atp-" + r(22, URLSAFE))
tok("square legacy secret", "sq0" + "csp-" + r(43, URLSAFE))
bot_id = b64encode(b"123456789012345678").decode().rstrip("=").replace("+", "-").replace("/", "_")
tok("discord bot", "M" + bot_id[1:] + "." + r(6, URLSAFE) + "." + r(30, URLSAFE))
tok("discord bot id not digits", "M" + r(23, URLSAFE) + "." + r(6, URLSAFE) + "." + r(30, URLSAFE))
# Formats taken from gitleaks
tok("1password sa", "ops" + "_eyJ" + r(260, B64))
tok("age secret key", "AGE-SECRET" + "-KEY-1" + r(58, "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L"))
tok("alibaba", "LT" + "AI" + r(20))
tok("artifactory", "AK" + "Cp" + r(69))
tok("cloudflare origin ca", "v1" + ".0-" + r(24, HEX) + "-" + r(146, HEX))
tok("dynatrace", "dt0" + "c01." + r(24) + "." + r(64))
tok("easypost", "EZ" + "AK" + r(54))
tok("flyio fo1", "fo1" + "_" + r(43, URLSAFE))
tok("flyio fm2", "fm2" + "_" + r(120, B64))
tok("grafana glc", "glc" + "_" + r(40, B64))
tok("grafana glsa", "gl" + "sa_" + r(32) + "_" + r(8, HEX))
tok("terraform cloud", r(14, LOWER_DIGITS) + ".atlas" + "v1." + r(64, URLSAFE))
tok("heroku v2", "HRKU" + "-AA" + r(58, URLSAFE))
tok("notion", "ntn" + "_" + r(11, DIGITS) + r(35))
tok("perplexity", "pplx" + "-" + r(48))
tok("planetscale", "pscale" + "_tkn_" + r(40, URLSAFE))
tok("postman", "PM" + "AK-" + r(24, HEX) + "-" + r(34, HEX))
tok("prefect", "pnu" + "_" + r(36))
tok("prefect placeholder", "pnu" + "_" + "0" * 36)
tok("pulumi", "pul" + "-" + r(40, HEX))
tok("readme", "rdme" + "_" + r(70, LOWER_DIGITS))
tok("rubygems", "rubygems" + "_" + r(48, HEX))
tok("brevo", "xkeysib" + "-" + r(64, HEX) + "-" + r(16))
tok("sentry user", "sntryu" + "_" + r(64, HEX))
tok("shippo", "shippo" + "_live_" + r(40, HEX))
tok("openshift", "sha256" + "~" + r(43, URLSAFE))


def guid():
    return r(8, LOWER_DIGITS) + "-" + "-".join(r(4, LOWER_DIGITS) for _ in range(3)) + "-" + r(12, LOWER_DIGITS)


tok("teams webhook", "https://" + r(8, LOWER_DIGITS) + ".webhook.office" + ".com/webhookb2/" + guid() + "@" + guid()
    + "/IncomingWebhook/" + r(32, LOWER_DIGITS) + "/" + guid())
tok("azure ad client secret", "abc1" + "Q~" + r(34, ALNUM + "_~."))
# JWT, private keys, URLs, bearer
tok("jwt", "eyJ" + r(20, URLSAFE) + ".eyJ" + r(20, URLSAFE) + "." + r(30, URLSAFE))
tok("jwt short parts", "eyJ" + r(8, URLSAFE) + ".eyJ" + r(8, URLSAFE) + "." + r(16, URLSAFE))
tok("jwt short signature", "eyJ" + r(20, URLSAFE) + ".eyJ" + r(20, URLSAFE) + "." + r(11, URLSAFE))
body = "\n".join(r(64, B64) for _ in range(3))
for label in ("", "RSA ", "EC ", "DSA ", "OPENSSH ", "ENCRYPTED "):
    case("private key " + (label.strip() or "bare"),
         "-----BEGIN " + label + "PRIVATE" + " KEY-----\n" + body + "\n-----END " + label + "PRIVATE" + " KEY-----\n")
case("private key pgp block",
     "-----BEGIN PGP PRIVATE" + " KEY BLOCK-----\n" + body + "\n-----END PGP PRIVATE" + " KEY BLOCK-----\n")
case("private key unknown label",
     "-----BEGIN FOO PRIVATE" + " KEY-----\n" + body + "\n-----END FOO PRIVATE" + " KEY-----\n")
case("private key truncated", "-----BEGIN PRIVATE" + " KEY-----\n" + body + "\n")
case("private key header only", "-----BEGIN PRIVATE" + " KEY-----\n")
for scheme in ("postgres", "mysql", "mongodb+srv", "redis", "amqp", "https", "ftp", "smtp", "s3"):
    tok("url password " + scheme, scheme + "://app:" + r(20, URLSAFE) + "@db.example.com:5432/app")
tok("url password short", "postgres://app:" + r(4) + "@db.example.com/app")
tok("url password placeholder", "postgres://app:changeme@db.example.com/app")
case("bearer header", "Authorization: Bearer " + r(30, URLSAFE) + "\n")
case("bearer masked", "Authorization: Bearer " + "x" * 30 + "\n")

# Cases where the engines differ on purpose (case label -> reason).
ALLOWED = {
    # Python reads what rules.js reads, and keeps the looser or wider shapes of that shared table. Each
    # case below is redacted only by Python. Nothing is lost on the Node.js side that matters: the
    # Node.js rules.js (redactSecrets, the hook and result paths) has the same forms.
    "anthropic masked body": "python only: a masked sk-ant body (x...x) is redacted, the scrubber leaves masks alone",
    "anthropic 30 without shape": "python only: sk-ant- plus 30 characters with no api03-style segment (rules.js form)",
    "openai plain 28": "python only: sk- plus 28 to 39 letters and digits (rules.js form; the scrubber asks for 40)",
    "openai low entropy 48": "python only: no randomness check on the shared sk- rule (rules.js form)",
    "aws key id repeated body": "python only: AKIA plus one repeated letter, the shared rule has no repeat check",
    "github ghp low entropy": "python only: no randomness check on the shared ghp_ rule (rules.js form)",
    "github fine-grained 82 with underscores": "python only: github_pat_ plus 82 characters with underscores (rules.js form)",
    "jwt short signature": "python only: signature of 10 to 15 characters (rules.js form; the scrubber asks for 16)",
    "private key unknown label": "python only: any capital-letter label before PRIVATE KEY (rules.js form)",
    "url password short": "python only: db_url_password has no length check (the scrubber asks for 6 characters)",
    "url password placeholder": "python only: db_url_password redacts a placeholder password such as changeme",
}


def node_spans(texts):
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed: skipping the Node.js/Python secret parity check")
    if not EXPORT_SCRIPT.is_file() or not PATTERNS_JS.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the secret parity check")
    with tempfile.TemporaryDirectory() as tmp:
        cases = Path(tmp) / "cases.json"
        cases.write_text(json.dumps(texts), encoding="utf8")
        out = subprocess.run([node, str(EXPORT_SCRIPT), str(cases)], cwd=tmp, check=True,
                             capture_output=True, timeout=120).stdout
    return json.loads(out.decode("utf8"))


def node_set(spans):
    out = set()
    for typ, start, end in spans:
        if typ == "SECRET":
            continue
        out.add((FAMILY.get(typ, typ), start, end))
    return out


def python_set(text):
    out = set()
    for d in redact_secrets(text)[1]:
        name = d["rule"].split(":", 1)[1]
        if name in GENERIC:
            continue
        out.add((FAMILY.get(name, name.upper()), d["start"], d["end"]))
    return out


def same(n, p):
    """Equal, or for the WIDE rules the Node.js span inside the Python one."""
    if n == p:
        return True
    if len(n) != len(p):
        return False
    for typ, s, e in n:
        if not any(pt == typ and ((ps, pe) == (s, e) or (typ in WIDE and ps <= s and e <= pe))
                   for pt, ps, pe in p):
            return False
    return True


class SecretScrubParityTest(unittest.TestCase):
    def test_same_secrets_same_types_and_spans(self):
        texts = [t for _, t in CASES]
        js = node_spans(texts)
        diffs = {}
        for (label, text), spans in zip(CASES, js, strict=True):
            n, p = node_set(spans), python_set(text)
            if not same(n, p):
                diffs[label] = (sorted(n), sorted(p))
        unexpected = {k: v for k, v in diffs.items() if k not in ALLOWED}
        stale = sorted(k for k in ALLOWED if k not in diffs)
        detail = "\n".join("%s\n  node:   %s\n  python: %s" % (k, v[0], v[1]) for k, v in list(unexpected.items())[:60])
        self.assertEqual(unexpected, {}, "%d cases differ:\n%s" % (len(unexpected), detail))
        self.assertEqual(stale, [], "these ALLOWED cases no longer differ: remove them")

    def test_node_types_have_a_python_rule(self):
        if not PATTERNS_JS.is_file():
            self.skipTest("packages/zn-gate is not next to this package")
        source = PATTERNS_JS.read_text(encoding="utf8")
        # Only the secret table: from PATTERNS to the end of it, not the PII layer.
        secret_table = source[source.index("const PATTERNS = ["):source.index("const SECRET_TYPES")]
        node_types = set(re.findall(r"\{ type: '([A-Z0-9_]+)'", secret_table)) - {"SECRET"}
        py_rules = {d[0].split(":", 1)[1].partition("#")[0] for d in
                    R.SCRUB_FIRST_PATTERNS + R.SECRET_PATTERNS + R.PROVIDER_SECRET_PATTERNS + R.SCRUB_LAST_PATTERNS}
        py_types = {FAMILY.get(n, n.upper()) for n in py_rules}
        missing = sorted(t for t in node_types if FAMILY.get(t, t) not in py_types)
        self.assertEqual(missing, [], "Node.js secret types without a Python rule of the same name")


if __name__ == "__main__":
    unittest.main()
