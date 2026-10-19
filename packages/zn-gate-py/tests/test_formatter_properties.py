"""Property tests for the `zn-gate scan` report formatters (text, json, github).

hypothesis generates the findings: benign strings only (unicode, newlines,
quotes, percent signs, colons, commas, very long values) and fictitious
rule ids. Each property says what the formatter must never do: lose a
finding, duplicate one, or print output that a parser would reject.
"""

import contextlib
import io
import json
import re

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zn_gate import cli

SETTINGS = settings(
    max_examples=100,
    deadline=None,
    database=None,
    suppress_health_check=[HealthCheck.too_slow],
)

RULE_IDS = [
    "secret:aws_access_key",
    "secret:github_token",
    "pii:email",
    "prompt_injection",
    "hidden_tag",
]

_CHARS = st.characters(blacklist_categories=("Cs",))

# Benign text with the characters that formatters must handle with care.
SPECIAL = st.sampled_from([
    "plain text",
    'say "hi" and \'bye\'',
    "100% done, 50%25 off",
    "a:b:c, d,e",
    "first line\nsecond line\r\nthird",
    "tab\there",
    "naive cafe é 日本語 \U0001f642",
    "https://example.com/a?b=c%20d",
    "zn_test_xxxxxxxxxxxxxxxx",
    "%0A%0D%3A%2C literal escapes",
    "x" * 4000,
])
TEXT = st.one_of(st.text(_CHARS, max_size=60), SPECIAL)
# Text output has no escaping; brackets are kept out of its fields so that
# "[rule]" can be counted exactly.
TEXT_NO_BRACKETS = TEXT.map(lambda s: s.replace("[", "(").replace("]", ")"))

PATH = st.text(_CHARS, min_size=1, max_size=60).map(lambda s: "agents/" + s)


def violation(text):
    return st.fixed_dictionaries({
        "file": PATH,
        "line": st.integers(min_value=1, max_value=10 ** 6),
        "rule": st.sampled_from(RULE_IDS),
        "reason": text,
        "type": st.sampled_from(["secret_leak", "threat"]),
        "content": text,
        "next_step": text,
    })


VIOLATIONS = st.lists(violation(TEXT), max_size=12)
VIOLATIONS_TEXT = st.lists(violation(TEXT_NO_BRACKETS), max_size=12)
SKIPPED = st.lists(
    st.fixed_dictionaries({"file": PATH, "reason": TEXT}),
    max_size=5,
)
COUNTS = st.integers(min_value=0, max_value=10 ** 6)


def _render(fmt, scanned, skipped, violations):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        cli._print_report(fmt, scanned, skipped, violations)
    return buf.getvalue()


def _leaks(violations):
    return sum(1 for v in violations if v["type"] == "secret_leak")


# ---------------------------------------------------------------- json

@SETTINGS
@given(COUNTS, SKIPPED, VIOLATIONS)
def test_json_is_valid_and_keeps_every_finding(scanned, skipped, violations):
    out = json.loads(_render("json", scanned, skipped, violations))
    # Same findings, same order, same content: none lost, none added or duplicated.
    assert out["threats"] == violations
    assert out["total_threats"] == len(violations)
    assert out["total_secrets"] == _leaks(violations)
    assert out["total_files"] == scanned
    assert out["skipped"] == skipped
    assert out["total_skipped"] == len(skipped)


# ---------------------------------------------------------------- github

_ESCAPES = {"%25": "%", "%0D": "\r", "%0A": "\n", "%3A": ":", "%2C": ","}


def _unescape(s):
    """Inverse of the workflow-command escaping, one pass (so %25 is decoded first)."""
    return re.sub(r"%(?:25|0D|0A|3A|2C)", lambda m: _ESCAPES[m.group(0)], s)


def _parse_command(line):
    """Split '::name key=value,...::message' into (name, {key: escaped value}, message)."""
    _, head, message = line.split("::", 2)
    name, _, rest = head.partition(" ")
    props = {}
    for item in rest.split(","):
        key, _, value = item.partition("=")
        props[key] = value
    return name, props, message


@SETTINGS
@given(COUNTS, SKIPPED, VIOLATIONS)
def test_github_one_command_line_per_finding(scanned, skipped, violations):
    output = _render("github", scanned, skipped, violations)
    # Split on \n only: str.splitlines would also break on other separators.
    lines = output.split("\n")
    errors = [ln for ln in lines if ln.startswith("::error ")]
    notices = [ln for ln in lines if ln.startswith("::notice ")]
    assert len(errors) == len(violations)
    assert len(notices) == len(skipped)
    for line, v in zip(errors, violations, strict=False):
        name, props, message = _parse_command(line)
        assert name == "error"
        assert int(props["line"]) == v["line"]
        assert _unescape(props["file"]) == v["file"]
        kind = "Secret found" if v["type"] == "secret_leak" else "Security Threat"
        assert _unescape(props["title"]) == f"{kind} ({v['rule']})"
        expected = v["next_step"] if v["type"] == "secret_leak" else v["reason"]
        assert _unescape(message) == expected
    for line, s in zip(notices, skipped, strict=False):
        name, props, message = _parse_command(line)
        assert _unescape(props["file"]) == s["file"]
        assert _unescape(message) == s["reason"]


@SETTINGS
@given(COUNTS, SKIPPED, VIOLATIONS)
def test_github_has_no_raw_line_breaks_inside_a_command(scanned, skipped, violations):
    output = _render("github", scanned, skipped, violations)
    for line in output.split("\n"):
        if line.startswith("::"):
            assert "\r" not in line
            assert line.count("::") >= 2


# ---------------------------------------------------------------- text

@SETTINGS
@given(COUNTS, SKIPPED, VIOLATIONS_TEXT)
def test_text_mentions_each_finding_rule_once(scanned, skipped, violations):
    output = _render("text", scanned, skipped, violations)
    if not violations:
        assert "All scanned prompts, tool definitions, and files are clean!" in output
        return
    for rule in set(v["rule"] for v in violations):
        expected = sum(1 for v in violations if v["rule"] == rule)
        assert output.count("[" + rule + "]") == expected
    total = len(violations)
    leaks = _leaks(violations)
    assert f"Found {leaks} secrets and {total - leaks} threat vectors" in output


@SETTINGS
@given(COUNTS, SKIPPED, VIOLATIONS_TEXT)
def test_text_prints_one_entry_per_finding(scanned, skipped, violations):
    output = _render("text", scanned, skipped, violations)
    for v in violations:
        label = "Secret found" if v["type"] == "secret_leak" else "Threat"
        entry = f"  {v['file']}:{v['line']} {label} [{v['rule']}] {v['reason']}"
        assert output.count(entry) >= 1
    # Entries are one per finding: the count of rule tags equals the count of findings.
    tags = re.findall(r"\[(?:%s)\]" % "|".join(re.escape(r) for r in RULE_IDS), output)
    assert len(tags) == len(violations)
