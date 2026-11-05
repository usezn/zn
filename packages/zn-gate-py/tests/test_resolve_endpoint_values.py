"""resolve_endpoint returns configured URLs unchanged, whatever their shape."""

import pytest

from zn_gate import client

ZN_VARS = ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_URL", "ZN_STAGE", "ZN_LONG_INPUT")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ZN_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("value", [
    "https://example.com/",
    "https://example.com/v1/analyze/",
    "https://example.com/some/path/analyze",
    "http://192.0.2.10:8080/analyze",
    "ftp://example.com/analyze",
    "file:///tmp/example/analyze",
    "example.invalid/analyze",
])
def test_env_value_is_returned_unchanged(monkeypatch, value):
    monkeypatch.setenv("ZN_API_URL", value)
    assert client.resolve_endpoint() == value


@pytest.mark.parametrize("value", [
    "https://example.com/",
    "https://example.com/custom/path",
    "ftp://example.com/analyze",
])
def test_option_value_is_returned_unchanged(monkeypatch, value):
    monkeypatch.setenv("ZN_API_URL", "https://example.com/from-env")
    assert client.resolve_endpoint({"api_url": value}) == value


def test_empty_env_and_empty_option_give_default(monkeypatch):
    monkeypatch.setenv("ZN_API_URL", "")
    assert client.resolve_endpoint({"api_url": ""}) == client.DEFAULT_ENDPOINT


def test_default_endpoint_value(monkeypatch):
    assert client.resolve_endpoint() == "https://api.usezn.com/v30/analyze"


def test_patched_default_endpoint_is_used(monkeypatch):
    monkeypatch.setattr(client, "DEFAULT_ENDPOINT", "https://example.com/patched")
    assert client.resolve_endpoint() == "https://example.com/patched"
