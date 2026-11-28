"""Percent-encoded phone values and Chinese bank cards in the Python PII preview, like the Node.js scrubber.

Every value is invented. The Node.js side is packages/zn-gate/test/pii_keyed_phone_card.test.js; the shared
texts are in test/fixtures/pii_parity_cases.json (tests/test_pii_parity.py).
"""

import pytest

from zn_gate import rules as R


def _values(text, kind):
    return [text[s:e] for s, e, k in R.find_pii_spans(text) if k == kind]


@pytest.mark.parametrize("text,expected", [
    ("phone=%2B34600123456", ["%2B34600123456"]),
    ("phone=%2b447911123456&x=1", ["%2b447911123456"]),
    ("phone=%2B34%20600%20123%20456", ["%2B34%20600%20123%20456"]),
    ("?tel=%2b34%20600%20123%20456&x=1", ["%2b34%20600%20123%20456"]),
    ("phone=+34%20600%20123%20456", ["+34%20600%20123%20456"]),
    ("phone=%2B34%20600123456", ["%2B34%20600123456"]),
    ("phone=%2B34 600 123 456", ["%2B34 600 123 456"]),
])
def test_percent_encoded_plus_and_spaces_are_a_phone(text, expected):
    assert _values(text, "PHONE") == expected


@pytest.mark.parametrize("text", [
    "x=%2B34%20600", "sum=%2B1%202", "v=%2B0%20600%20123%20456", "a=%2B1%202%203",
    "100%2B3400000000", "x%2B34600123456",
])
def test_short_or_glued_values_are_not_a_phone(text):
    assert _values(text, "PHONE") == []


def test_mask_keeps_the_key_and_hides_the_value():
    assert R.mask_pii_preview("phone=%2B34%20600%20123%20456&a=1") == "phone=[REDACTED_PHONE]&a=1"


@pytest.mark.parametrize("value", [
    "6222020123456789015", "6222 0201 2345 6789 015", "8100000123456789015", "8100 0001 2345 6789 015",
    "9558800123456789015", "9558-8001-2345-6789-015",
])
def test_chinese_19_digit_cards(value):
    assert _values(f"card {value} end", "CARD") == [value]


@pytest.mark.parametrize("value", [
    "8100000123456789016", "9558800123456789016", "955880012345678901", "9560800123456789019",
    "1700000000000000000", "1700000000123456789", "9558800123456789015a", "19558800123456789015",
])
def test_other_long_numbers_are_not_cards(value):
    assert _values(f"id {value} end", "CARD") == []
