"""The preview of `zn-gate test` masks the same personal values as the Node.js scrubber.

packages/zn-gate/test/fixtures/pii_parity_cases.json holds texts with invented values and the spans
(type, value) that the Node.js PII layer finds in each; test/pii_parity.test.js keeps it true on the
Node.js side. Here the Python port must give the same spans, and the same validator verdicts as the
shared card, SSN and phone cases of scrub_validator_cases.json. Skipped when the monorepo fixtures are
missing (for example when testing an sdist).
"""

import json
from pathlib import Path

import pytest

from zn_gate import rules as R

FIXTURES = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures"
PII_FILE = FIXTURES / "pii_parity_cases.json"
VALIDATOR_FILE = FIXTURES / "scrub_validator_cases.json"

pytestmark = pytest.mark.skipif(not PII_FILE.exists(), reason="needs the monorepo fixtures")


def _cases():
    return json.loads(PII_FILE.read_text(encoding="utf-8"))["cases"]


def test_corpus_is_not_empty_and_covers_every_type():
    seen = {s[0] for c in _cases() for s in c["spans"]}
    assert {"EMAIL", "PHONE", "IBAN", "CARD", "DNI", "NIE", "SSN"} <= seen


@pytest.mark.parametrize("case", _cases(), ids=lambda c: repr(c["text"])[:40])
def test_spans_equal_node(case):
    text = case["text"]
    got = [[kind, text[start:end]] for start, end, kind in R.find_pii_spans(text)]
    assert got == case["spans"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: repr(c["text"])[:40])
def test_mask_replaces_exactly_those_values(case):
    text = case["text"]
    expected, cursor = "", 0
    for kind, value in case["spans"]:
        at = text.index(value, cursor)
        expected += text[cursor:at] + "[REDACTED_" + kind + "]"
        cursor = at + len(value)
    assert R.mask_pii_preview(text) == expected + text[cursor:]


def test_validators_match_the_shared_cases():
    cases = json.loads(VALIDATOR_FILE.read_text(encoding="utf-8"))["cases"]
    checks = {"luhn": R._luhn_ok, "card": R._card_ok, "ssn": R._ssn_ok, "e164": R._e164_ok}
    assert {c["fn"] for c in cases} <= set(checks)
    for c in cases:
        assert checks[c["fn"]](c["input"]) is c["valid"], c


def test_checksum_validators_known_values():
    assert R._dni_ok("12345678Z") and R._dni_ok("12345678-Z") and not R._dni_ok("12345678A")
    assert R._nie_ok("X1234567L") and not R._nie_ok("X1234567A")
    assert R._iban_ok("DE89 3704 0044 0532 0130 00") and not R._iban_ok("DE00370400440532013000")
    assert not R._iban_ok("XX89370400440532013000")
