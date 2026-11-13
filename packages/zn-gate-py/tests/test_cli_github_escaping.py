"""Escaping helpers for GitHub workflow commands in cli.py."""
import pytest

from zn_gate import cli


@pytest.mark.parametrize("text, expected", [
    ("100%", "100%25"),
    ("%0A", "%250A"),
    ("a\rb", "a%0Db"),
    ("a\nb", "a%0Ab"),
    ("a\r\nb", "a%0D%0Ab"),
    ("a:b", "a%3Ab"),
    ("a,b", "a%2Cb"),
    ("", ""),
    ("café 日本語 \U0001F512", "café 日本語 \U0001F512"),
    ("déjà:vu,ü", "déjà%3Avu%2Cü"),
])
def test_gh_property(text, expected):
    assert cli._gh_property(text) == expected


@pytest.mark.parametrize("text, expected", [
    ("100%", "100%25"),
    ("%0A", "%250A"),
    ("a\rb", "a%0Db"),
    ("a\nb", "a%0Ab"),
    ("a\r\nb", "a%0D%0Ab"),
    ("a:b,c", "a:b,c"),
    ("", ""),
    ("café 日本語 \U0001F512", "café 日本語 \U0001F512"),
    ("ü:é,\n", "ü:é,%0A"),
])
def test_gh_message(text, expected):
    assert cli._gh_message(text) == expected


def test_gh_helpers_convert_non_strings():
    assert cli._gh_property(12) == "12"
    assert cli._gh_message(None) == "None"
