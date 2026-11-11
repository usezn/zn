"""zn-gate test prints a redacted preview: no secret or personal value from the
text it was given is printed back. Only invented values are used."""

import argparse
import json

from zn_gate import cli
from zn_gate.rules import mask_pii_preview

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"
FAKE_EMAIL = "jane.doe@example.com"
FAKE_IBAN = "DE89370400440532013000"
FAKE_CARD = "4111111111111111"
FAKE_PHONE = "+34 600 123 456"
FAKE_PASSWORD_VALUE = "NotARealPass1"
TEXT = (
    f"Contact {FAKE_EMAIL}, card {FAKE_CARD}, iban {FAKE_IBAN}, phone {FAKE_PHONE}, "
    f"password={FAKE_PASSWORD_VALUE}, key {FAKE_AWS}"
)
RAW_VALUES = [FAKE_EMAIL, FAKE_IBAN, FAKE_CARD, FAKE_PHONE, FAKE_PASSWORD_VALUE, FAKE_AWS]


def test_text_output_never_prints_the_values(capsys):
    code = cli.cmd_test(argparse.Namespace(text=TEXT, json=False))
    out = capsys.readouterr().out
    assert code == 1
    for value in RAW_VALUES:
        assert value not in out
    for token in ("[REDACTED_EMAIL]", "[REDACTED_IBAN]", "[REDACTED_CARD]",
                  "[REDACTED_PHONE]", "[REDACTED_PASSWORD]", "[REDACTED_AWS_KEY]"):
        assert token in out


def test_json_output_has_no_raw_value_in_any_field(capsys):
    code = cli.cmd_test(argparse.Namespace(text=TEXT, json=True))
    out = capsys.readouterr().out
    data = json.loads(out)
    assert code == 1
    assert data["secrets_detected"] >= 1
    assert "redacted_preview" in data
    for value in RAW_VALUES:
        assert value not in out


def test_clean_text_output_is_unchanged(capsys):
    text = "Summarize the quarterly revenue report."
    code = cli.cmd_test(argparse.Namespace(text=text, json=True))
    data = json.loads(capsys.readouterr().out)
    assert code == 0
    assert data["secrets_detected"] == 0
    assert "redacted_preview" not in data


def test_clean_text_plain_output_has_no_dlp_line(capsys):
    cli.cmd_test(argparse.Namespace(text="Summarize the quarterly revenue report.", json=False))
    assert "DLP Alert" not in capsys.readouterr().out


def test_mask_pii_preview_keeps_text_without_personal_values():
    text = "Summarize the quarterly revenue report, 12 items on 2026-11-01."
    assert mask_pii_preview(text) == text


def test_mask_pii_preview_keeps_numbers_that_fail_their_checksum():
    text = "order 4111111111111112 and IBAN DE00370400440532013000"
    assert mask_pii_preview(text) == text


MULTI_WORD = "My Secret Phrase"
MULTI_TEXT = f'password="{MULTI_WORD}" and pwd=\'{MULTI_WORD} Two\' and key {FAKE_AWS}'
MULTI_PARTS = ["My", "Secret", "Phrase", "Two"]


def test_text_output_masks_a_whole_quoted_password(capsys):
    code = cli.cmd_test(argparse.Namespace(text=MULTI_TEXT, json=False))
    out = capsys.readouterr().out
    assert code == 1
    for part in MULTI_PARTS:
        assert part not in out
    assert out.count("[REDACTED_PASSWORD]") == 2


def test_json_output_masks_a_whole_quoted_password(capsys):
    code = cli.cmd_test(argparse.Namespace(text=MULTI_TEXT, json=True))
    out = capsys.readouterr().out
    data = json.loads(out)
    assert code == 1
    for part in MULTI_PARTS:
        assert part not in out
    assert data["redacted_preview"].count("[REDACTED_PASSWORD]") == 2


def test_mask_pii_preview_password_value_forms():
    assert mask_pii_preview('password="My Secret Phrase" next') == "password=[REDACTED_PASSWORD] next"
    assert mask_pii_preview("passwd: 'My Secret Phrase' next") == "passwd: [REDACTED_PASSWORD] next"
    assert mask_pii_preview('password="a \\"b\\" c" next') == "password=[REDACTED_PASSWORD] next"
    # Unquoted: to the end of the token only.
    assert mask_pii_preview("pwd=hunter two") == "pwd=[REDACTED_PASSWORD] two"
