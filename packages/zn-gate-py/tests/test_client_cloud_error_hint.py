"""
cloud_error_hint: one plain sentence per failure kind, with no traceback
and no address in it. Errors are built by hand; nothing opens a socket.
"""

import io
import urllib.error

import pytest

from zn_gate.client import cloud_error_hint

URL = "https://api.example.com/v30/analyze"


def _http(code):
    return urllib.error.HTTPError(URL, code, "msg", {}, io.BytesIO(b""))


CASES = [
    (_http(401), "did not accept the API key"),
    (_http(403), "did not accept the API key"),
    (_http(500), "HTTP 500"),
    (TimeoutError("timed out"), "took too long"),
    (urllib.error.URLError(TimeoutError("timed out")), "took too long"),
    (urllib.error.URLError("name not known"), "could not be reached"),
    (ValueError("bad value"), "The cloud check failed."),
]


@pytest.mark.parametrize("exc,expected", CASES)
def test_hint_text(exc, expected):
    assert expected in cloud_error_hint(exc)


@pytest.mark.parametrize("exc,expected", CASES)
def test_hint_is_one_plain_sentence(exc, expected):
    hint = cloud_error_hint(exc)
    assert "\n" not in hint
    assert "Traceback" not in hint
    assert "example.com" not in hint
    assert "http://" not in hint and "https://" not in hint
    assert hint.endswith((".", "later."))
    assert hint.count(". ") == 0


def test_address_in_error_message_is_not_echoed():
    exc = urllib.error.URLError(f"cannot connect to {URL}")
    assert URL not in cloud_error_hint(exc)
