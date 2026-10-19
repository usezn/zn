"""Property tests against false negatives in the secret scrubber, and parity with Node.js.

hypothesis embeds fictitious provider keys in prose, JSON, .env lines and
URLs and checks that each key is replaced while the text around it is kept.
Every key carries the EXAMPLE marker right after its prefix and has the length
and character layout of the real provider format. Keys are assembled at run
time, so this file holds no key-shaped literal.

Bodies that a provider's own randomness gate treats as placeholders (for
example a run of zeros) are not generated: that gate is shared with the Node.js
scrubber, so a placeholder body is not a detection miss.

The parity tests run a deterministic corpus through the Node.js scrubber
(lib/scrub/engine.js `scan`, and lib/rules.js `redactSecrets`). They need the
monorepo checkout and a `node` binary; without them they are skipped.
"""

import json
import random
import shutil
import string
import subprocess
import tempfile
from pathlib import Path

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zn_gate import rules as R

SETTINGS = settings(
    max_examples=120,
    derandomize=True,
    deadline=None,
    database=None,
    suppress_health_check=[HealthCheck.too_slow],
)

UPPER_DIGITS = string.ascii_uppercase + string.digits
ALNUM = string.ascii_letters + string.digits
TOKEN_DASH = ALNUM + "_-"
MARKER = "EXAMPLE"

# Each provider: (rule id, prefix, layout). The marker follows the prefix. A layout
# item is either a literal string or (length, alphabet, minimum bits of entropy
# the rule's randomness gate asks for; 0 when the rule has none).
PROVIDERS = [
    ("secret:aws_access_key", "AKIA", [(9, UPPER_DIGITS, 0)]),
    ("secret:github_token", "ghp_", [(29, ALNUM, 0)]),
    # Fine-grained PAT: 22 characters, an underscore, then 59 characters.
    ("secret:github_token", "github_pat_", [(15, ALNUM, 0), "_", (59, ALNUM, 0)]),
    ("secret:stripe_key", "sk_test_", [(20, ALNUM, 3.5)]),
    ("secret:stripe_webhook_secret", "whsec_", [(27, ALNUM, 0)]),
    ("secret:openai_key", "sk-proj-", [(28, ALNUM, 0)]),
    ("secret:openai_key", "sk-", [(33, ALNUM, 0)]),
    ("secret:anthropic_key", "sk-ant-api03-", [(30, TOKEN_DASH, 0)]),
    ("secret:slack_token", "xoxb-0000000000-", [(8, ALNUM + "-", 0)]),
    ("secret:google_api_key", "AIza", [(28, TOKEN_DASH, 0)]),
    ("secret:hf_token", "hf_", [(30, ALNUM, 3.0)]),
    ("secret:npm_token", "npm_", [(29, ALNUM, 3.8)]),
    ("secret:gitlab_token", "glpat-", [(16, TOKEN_DASH, 3.3)]),
    ("secret:pypi_token", "pypi-AgE", [(50, TOKEN_DASH, 0)]),
]

PROVIDER_IDS = [f"{rule.split(':')[1]}-{prefix}" for rule, prefix, _ in PROVIDERS]

# Benign words only, so the surrounding text cannot contain a credential.
WORD = st.text(alphabet=string.ascii_lowercase, min_size=0, max_size=12)


def _body(alphabet: str, length: int, min_bits: float):
    """A random body, restricted to bodies a provider's randomness gate accepts."""
    strategy = st.text(alphabet=alphabet, min_size=length, max_size=length)
    if min_bits:
        strategy = strategy.filter(lambda s: R._pv_random(s, 2, min_bits))
    return strategy


def _build_key(prefix: str, layout, draw) -> str:
    """Assemble a key; draw(alphabet, length, min_bits) returns one random part."""
    parts = [prefix, MARKER]
    for item in layout:
        if isinstance(item, str):
            parts.append(item)
        else:
            length, alphabet, min_bits = item
            parts.append(draw(alphabet, length, min_bits))
    return "".join(parts)


def _embed(key: str, pre: str, post: str, ctx: str):
    """Return (text, text before the key, text after the key)."""
    if ctx == "prose":
        before, after = f"{pre} ", f" {post}"
    elif ctx == "json":
        before = f'{{"note": "{pre}", "value": "'
        after = f'", "tail": "{post}"}}'
    elif ctx == "dotenv":
        before = f"# {pre}\nAPP_LABEL="
        after = f"\nNOTE={post}\n"
    else:  # url
        before = f"https://example.invalid/cb?state={pre}&t="
        after = f"&lang={post}"
    return before + key + after, before, after


CONTEXTS = ["prose", "json", "dotenv", "url"]


def _assert_redacted(text: str, before: str, key: str, after: str) -> None:
    out, found = R.redact_secrets(text)
    assert found, f"no detection in {text!r}"
    assert key not in out, f"key survived: {out!r}"
    assert key[-12:] not in out, f"key tail survived: {out!r}"
    assert MARKER not in out, f"partial key survived: {out!r}"
    assert out.startswith(before), f"text before the key changed: {out!r}"
    assert out.endswith(after), f"text after the key changed: {out!r}"
    assert "REDACTED" in out[len(before):len(out) - len(after)], out


@SETTINGS
@given(provider=st.sampled_from(PROVIDERS), data=st.data(), pre=WORD, post=WORD, ctx=st.sampled_from(CONTEXTS))
def test_fake_provider_key_is_redacted_and_context_kept(provider, data, pre, post, ctx):
    _rule, prefix, layout = provider
    key = _build_key(prefix, layout, lambda alpha, n, bits: data.draw(_body(alpha, n, bits)))
    text, before, after = _embed(key, pre, post, ctx)
    _assert_redacted(text, before, key, after)


@SETTINGS
@given(
    picks=st.lists(st.sampled_from(PROVIDERS), min_size=2, max_size=4),
    data=st.data(),
    pre=WORD,
    post=WORD,
)
def test_several_fake_keys_in_one_text_are_all_redacted(picks, data, pre, post):
    keys = [
        _build_key(prefix, layout, lambda alpha, n, bits: data.draw(_body(alpha, n, bits)))
        for _rule, prefix, layout in picks
    ]
    separators = [" ", "\n", ", ", " | "]
    body = ""
    for i, key in enumerate(keys):
        body += key + (separators[i % len(separators)] if i < len(keys) - 1 else "")
    text = f"{pre} {body} {post}"
    out, found = R.redact_secrets(text)
    for key in keys:
        assert key not in out, f"key survived: {out!r}"
        assert key[-12:] not in out, f"key tail survived: {out!r}"
    assert MARKER not in out, out
    assert out.startswith(f"{pre} ") and out.endswith(f" {post}"), out
    assert len(found) >= len(keys), [d["rule"] for d in found]


@pytest.mark.xfail(
    strict=True,
    reason=("Python redact_secrets skips AWS ASIA/ABIA/ACCA ids whose value ends in EXAMPLE "
            "(PROVIDER_MATCH_CHECKS secret:aws_key_id), while AKIA ids with that suffix are redacted "
            "by secret:aws_access_key. Open: decide whether the exemption stays."),
)
@SETTINGS
@given(prefix=st.sampled_from(["ASIA", "ABIA", "ACCA"]), data=st.data(), pre=WORD, post=WORD)
def test_aws_session_key_id_with_example_suffix_is_redacted(prefix, data, pre, post):
    key = prefix + data.draw(st.text(alphabet=UPPER_DIGITS, min_size=9, max_size=9)) + MARKER
    text, before, after = _embed(key, pre, post, "prose")
    _assert_redacted(text, before, key, after)


def _corpus() -> list:
    """Deterministic corpus: (text, fake key or None, provider index or None)."""
    rng = random.Random(20261018)

    def draw(alphabet, length, _bits):
        return "".join(rng.choice(alphabet) for _ in range(length))

    items = []
    for index, (_rule, prefix, layout) in enumerate(PROVIDERS):
        for ctx in CONTEXTS:
            for _ in range(3):
                key = _build_key(prefix, layout, draw)
                pre = "".join(rng.choice(string.ascii_lowercase) for _ in range(rng.randint(0, 10)))
                post = "".join(rng.choice(string.ascii_lowercase) for _ in range(rng.randint(0, 10)))
                items.append((_embed(key, pre, post, ctx)[0], key, index))
    for word in ["note", "build finished", "deploy ok", "v1.2.3 released", "no secrets here"]:
        items.append((f"{word}\n  plain text with a path /usr/local/bin and a number 42", None, None))
    return items


NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
NODE_RULES = NODE_PKG / "lib" / "rules.js"
NODE_SCRUB = NODE_PKG / "lib" / "scrub" / "engine.js"

NODE_RULES_SCRIPT = (
    "const rules = require(process.argv[1]);"
    "const items = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
    "process.stdout.write(JSON.stringify(items.map((t) => rules.redactSecrets(t).sanitized)));"
)
NODE_SCRUB_SCRIPT = (
    "const engine = require(process.argv[1]);"
    "const items = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
    "process.stdout.write(JSON.stringify(items.map((t) => engine.scan(t).map((s) => [s.start, s.end, s.type]))));"
)


def _run_node(script: str, module: Path, items: list) -> list:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed: skipping the Python/Node scrubber parity check")
    if not module.is_file():
        pytest.skip("packages/zn-gate is not next to this package: skipping the scrubber parity check")
    # Run from an empty directory so no project config is picked up.
    with tempfile.TemporaryDirectory() as cwd:
        proc = subprocess.run(
            [node, "-e", script, str(module)],
            input=json.dumps(items).encode("utf-8"),
            cwd=cwd, capture_output=True, timeout=120, check=True,
        )
    return json.loads(proc.stdout.decode("utf-8"))


_CORPUS = _corpus()


@pytest.mark.parametrize("index", range(len(PROVIDERS)), ids=PROVIDER_IDS)
def test_node_scrub_engine_hides_the_same_keys_as_python(index):
    """Per provider: the Node scrub engine must cover every fake key that Python hides."""
    cases = [(text, key) for text, key, i in _CORPUS if i == index]
    spans = _run_node(NODE_SCRUB_SCRIPT, NODE_SCRUB, [text for text, _ in cases])
    mismatches = []
    for (text, key), node_spans in zip(cases, spans, strict=False):
        start = text.index(key)
        end = start + len(key)
        node_hides = any(s < end and e > start for s, e, _type in node_spans)
        py_hides = key not in R.redact_secrets(text)[0]
        if node_hides != py_hides:
            mismatches.append((key[:20], "python-only" if py_hides else "node-only"))
    assert not mismatches, f"{len(mismatches)} of {len(cases)} keys hidden by one engine only: {mismatches[:3]}"


def test_node_rules_redact_secrets_gives_the_same_text_as_python():
    items = [text for text, _key, _ in _CORPUS]
    node = _run_node(NODE_RULES_SCRIPT, NODE_RULES, items)
    mismatches = []
    for i, (text, expected) in enumerate(zip(items, node, strict=False)):
        out, _found = R.redact_secrets(text)
        if out != expected:
            mismatches.append((i, out[:70], expected[:70]))
    assert not mismatches, f"{len(mismatches)} mismatch(es), first: {mismatches[:2]}"
