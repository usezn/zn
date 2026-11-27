"""Seeded generator of FAKE provider keys split in many ways, for the scrubber fuzz.

Everything here is fictitious: public format prefixes, bodies drawn from a seeded PRNG with an
obvious FAKE (or 0000) marker, never a real credential. A case is fully reproducible from its
case seed string (see make_case). Used by test_scrubber_fuzz_slice.py, test_scrubber_fuzz_corpus.py
and the large run in fuzz_scrubber_at_scale.py; the Node.js side reads the saved corpus only.
"""

import math
import random
import re
from collections import Counter

ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
HEX = "0123456789abcdef"
DIGITS = "0123456789"
URL_SAFE = ALNUM + "-_"
BASE64 = ALNUM + "+/"

Q = {
    "alnum": (3, 3.5), "loose": (2, 3.3), "hex": (2, 3.0), "upper": (2, 2.5), "digits": (1, 0.0),
}


def _random_enough(s, q):
    classes = sum(1 for rx in ("[a-z]", "[A-Z]", r"\d") if re.search(rx, s))
    c = Counter(s)
    h = -sum(n / len(s) * math.log2(n / len(s)) for n in c.values())
    return classes >= q[0] and h >= q[1]


def body(rnd, n, alphabet, marker, q):
    while True:
        rest = n - len(marker)
        at = rnd.randint(0, rest)
        s = "".join(rnd.choice(alphabet) for _ in range(rest))
        s = s[:at] + marker + s[at:]
        if _random_enough(s, Q[q]):
            return s


def _pick(rnd, *xs):
    return rnd.choice(xs)


# name -> function(rnd) returning (key, offset where the secret body starts, keep label or "")
def _p(prefix_fn, *parts):
    def gen(rnd):
        pre = prefix_fn(rnd) if callable(prefix_fn) else prefix_fn
        return pre + "".join(parts_fn(rnd) for parts_fn in parts), len(pre)
    return gen


PROVIDERS = {
    "aws_access_key_id": lambda r: (lambda p: (p + body(r, 16, UPPER_DIGITS, "FAKE", "upper"), len(p)))(_pick(r, "AKIA", "ASIA")),
    "github_token": lambda r: (lambda p: (p + body(r, 36, ALNUM, "FAKE", "alnum"), len(p)))(_pick(r, "ghp_", "gho_", "ghu_", "ghs_", "ghr_")),
    "github_fine_grained": lambda r: ("github_pat_" + body(r, 22, ALNUM, "FAKE", "alnum") + "_" + body(r, 59, ALNUM, "", "alnum"), 11),
    "gitlab": lambda r: ("glpat-" + body(r, 20, ALNUM, "FAKE", "alnum"), 6),
    "slack_token": lambda r: (lambda p: (p + body(r, 10, DIGITS, "0000", "digits") + "-" + body(r, 12, DIGITS, "", "digits") + "-" + body(r, 24, ALNUM, "FAKE", "alnum"), len(p)))(_pick(r, "xoxb-", "xoxp-")),
    "stripe_secret": lambda r: (lambda p: (p + body(r, 24, ALNUM, "FAKE", "alnum"), len(p)))(_pick(r, "sk_test_", "sk_live_", "rk_test_", "rk_live_")),
    "stripe_webhook": lambda r: ("whsec_" + body(r, 40, ALNUM, "FAKE", "alnum"), 6),
    "openai_project": lambda r: ("sk-proj-" + body(r, 48, URL_SAFE, "FAKE", "alnum"), 8),
    "openai_legacy": lambda r: ("sk-" + body(r, 48, ALNUM, "FAKE", "alnum"), 3),
    "openai_hex": lambda r: ("sk-" + body(r, 32, HEX, "0000", "hex"), 3),
    "anthropic": lambda r: (lambda p: (p + body(r, 93, URL_SAFE, "FAKE", "alnum"), len(p)))("sk-ant-" + _pick(r, "api03-", "admin01-")),
    "google_api": lambda r: ("AIza" + body(r, 35, URL_SAFE, "FAKE", "alnum"), 4),
    "google_oauth_secret": lambda r: ("GOCSPX-" + body(r, 28, URL_SAFE, "FAKE", "alnum"), 7),
    "huggingface": lambda r: ("hf_" + body(r, 34, ALNUM, "FAKE", "alnum"), 3),
    "npm": lambda r: ("npm_" + body(r, 36, ALNUM, "FAKE", "alnum"), 4),
    "pypi": lambda r: ("pypi-AgE" + body(r, 60, URL_SAFE, "FAKE", "alnum"), 8),
    "sendgrid": lambda r: ("SG." + body(r, 22, URL_SAFE, "FAKE", "alnum") + "." + body(r, 43, URL_SAFE, "", "alnum"), 3),
    "twilio_key_sid": lambda r: ("SK" + body(r, 32, HEX, "0000", "hex"), 2),
    "mailgun": lambda r: ("key-" + body(r, 32, HEX, "0000", "hex"), 4),
    "shopify": lambda r: (lambda p: (p + body(r, 32, HEX, "0000", "hex"), len(p)))(_pick(r, "shpat_", "shpca_", "shppa_", "shpss_")),
    "digitalocean": lambda r: (lambda p: (p + body(r, 64, HEX, "0000", "hex"), len(p)))(_pick(r, "dop_v1_", "doo_v1_", "dor_v1_")),
    "linear": lambda r: ("lin_api_" + body(r, 40, ALNUM, "FAKE", "alnum"), 8),
    "databricks": lambda r: ("dapi" + body(r, 32, HEX, "0000", "hex"), 4),
    "vault": lambda r: (lambda p: (p + body(r, 32, URL_SAFE, "FAKE", "alnum"), len(p)))(_pick(r, "hvs.", "hvb.")),
    "groq": lambda r: ("gsk_" + body(r, 52, ALNUM, "FAKE", "alnum"), 4),
    "xai": lambda r: ("xai-" + body(r, 80, ALNUM, "FAKE", "alnum"), 4),
    "newrelic": lambda r: (lambda p: (p + body(r, 27, UPPER_DIGITS, "FAKE", "upper"), len(p)))(_pick(r, "NRAK-", "NRII-")),
    "dockerhub": lambda r: (lambda p: (p + body(r, 27, URL_SAFE, "FAKE", "loose"), len(p)))(_pick(r, "dckr_pat_", "dckr_oat_")),
    "zn_api": lambda r: ("zn_" + body(r, 48, HEX, "0000", "hex"), 3),
    "tavily": lambda r: ("tvly-" + body(r, 32, ALNUM, "FAKE", "alnum"), 5),
    "firecrawl": lambda r: ("fc-" + body(r, 32, ALNUM, "FAKE", "alnum"), 3),
    "polar": lambda r: ("polar_oat_" + body(r, 32, ALNUM, "FAKE", "alnum"), 10),
    "replicate": lambda r: ("r8_" + body(r, 37, ALNUM, "FAKE", "loose"), 3),
    "supabase": lambda r: ("sbp_" + body(r, 40, ALNUM, "FAKE", "alnum"), 4),
    "square": lambda r: ("EAAA" + body(r, 60, URL_SAFE, "FAKE", "loose"), 4),
    "telegram_bot": lambda r: (body(r, 10, DIGITS, "0000", "digits") + ":AA" + body(r, 33, URL_SAFE, "FAKE", "alnum"), 0),
    "azure_storage": lambda r: (body(r, 86, BASE64, "FAKE", "alnum") + "==", 0),
    "jwt": lambda r: ("eyJ" + body(r, 20, URL_SAFE, "", "alnum") + ".eyJ" + body(r, 24, URL_SAFE, "", "alnum") + "." + body(r, 43, URL_SAFE, "FAKE", "alnum"), 3),
    "slack_webhook": lambda r: ("https://hooks.slack.com/services/T0000/B0000/" + body(r, 24, ALNUM, "FAKE", "alnum"), len("https://hooks.slack.com/services/T0000/B0000/")),
    "discord_webhook": lambda r: ("https://discord.com/api/webhooks/" + body(r, 18, DIGITS, "0000", "digits") + "/" + body(r, 68, URL_SAFE, "FAKE", "alnum"), len("https://discord.com/api/webhooks/") + 19),
}
# Azure keys are only read after their label.
KEEP = {"azure_storage": "AccountKey="}
# These keys carry punctuation that is not a join, so they are only wrapped at word-safe places by the
# separators below like any other; nothing special is needed.

SEPARATORS = {
    "none": "",
    "lf": "\n",
    "crlf": "\r\n",
    "tab": "\t",
    "space_lf": " \n",
    "dq_lf": '"\n"',
    "sq_lf": "'\n'",
    "dq_plus": '"+"',
    "esc_n": "\\n",
    "u2028": "\u2028",
    "u2029": "\u2029",
    "nbsp": "\u00a0",
    "zwsp": "\u200b",
    "lf_indent": "\n    ",
    "backslash_lf": " \\\n",
}

# (name, prefix, suffix); {k} is the key.
CONTEXTS = {
    "bare": ("", ""),
    "json": ('{"name": "ci", "token": "', '", "retries": 3}'),
    "yaml": ("env:\n  SERVICE_TOKEN: ", "\n  REGION: eu-west-1\n"),
    "shell": ("export SERVICE_TOKEN=", "\nrun-deploy --now\n"),
    "shell_quoted": ("export SERVICE_TOKEN='", "'\nrun-deploy --now\n"),
    "markdown": ("The token is `", "` and it expires soon.\n"),
    "prose": ("Please rotate this value now: ", " before Friday."),
    "dotenv": ("DEBUG=1\nSERVICE_TOKEN=", "\nREGION=eu-west-1\n"),
}

PROVIDER_NAMES = sorted(PROVIDERS)
SEP_NAMES = sorted(SEPARATORS)
CTX_NAMES = sorted(CONTEXTS)


def wrap(key, width, sep):
    return sep.join(key[i:i + width] for i in range(0, len(key), width))


def make_case(case_seed):
    """case_seed is a string like 'split-keys:3:ghp:17'; the same string always gives the same case."""
    rnd = random.Random(case_seed)
    name = rnd.choice(PROVIDER_NAMES)
    return build_case(case_seed, name, rnd)


def build_case(case_seed, name, rnd=None):
    rnd = rnd or random.Random(case_seed + "|" + name)
    key, off = PROVIDERS[name](rnd)
    sep_name = rnd.choice(SEP_NAMES)
    ctx_name = rnd.choice(CTX_NAMES)
    width = rnd.randint(8, 80)
    keep = KEEP.get(name, "")
    pre, post = CONTEXTS[ctx_name]
    text = pre + keep + wrap(key, width, SEPARATORS[sep_name]) + post
    return {
        "seed": case_seed, "provider": name, "sep": sep_name, "ctx": ctx_name, "width": width,
        "key": key, "body_off": off, "text": text,
    }


def cases(seed, per_provider):
    for name in PROVIDER_NAMES:
        for i in range(per_provider):
            yield build_case("%s:%s:%d" % (seed, name, i), name)


_STRIP = re.compile(r"\\[nrt]|[\s\"'+\\`\u2028\u2029\u00a0\u200b\u200c\u200d\ufeff]")


def stripped(s):
    return _STRIP.sub("", s)


def remnant(case, out):
    """First run of 8 or more characters of the secret body still readable in out, or ''."""
    secret = case["key"][case["body_off"]:]
    flat = stripped(out)
    for i in range(0, max(len(secret) - 7, 0)):
        gram = secret[i:i + 8]
        if gram in flat:
            j = i + 8
            while j < len(secret) and secret[i:j + 1] in flat:
                j += 1
            return secret[i:j]
    return ""
