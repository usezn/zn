"""The API key is sent only to https://api.usezn.com; a gateway on this machine needs ZN_API_ALLOW_LOCALHOST=1, and
redirects are never followed. Fake keys and hosts only; the only server is a local one started by the test."""

import http.server
import threading
import urllib.error
from unittest import mock

import pytest

from zn_gate import client

FAKE_KEY = "zn_" + "f" * 48
TEXT = "What is the weather today?"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for v in ("ZN_API_URL", "ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_ALLOW_LOCALHOST", "ZN_STAGE", "ZN_VERBOSE"):
        monkeypatch.delenv(v, raising=False)


@pytest.mark.parametrize("url", [
    "https://api.usezn.com/v30/analyze",
    "https://api.usezn.com/prod/analyze",
    "https://API.usezn.com/v30/analyze",
    "https://api.usezn.com:443/v30/analyze",
])
def test_official_host_accepted(url):
    assert client.endpoint_refusal(url) is None


@pytest.mark.parametrize("url", [
    "http://api.usezn.com/v30/analyze",
    "https://collector.example.invalid/x",
    "https://api.usezn.com.example.invalid/x",
    "https://api.usezn.com:8443/v30/analyze",
    "https://user:pw@api.usezn.com/v30/analyze",
    "http://192.0.2.10/v30/analyze",
    "ftp://api.usezn.com/x",
    "https://api.usezn.com:99999/x",
    "not a url",
])
def test_other_urls_refused(url, monkeypatch):
    monkeypatch.setenv("ZN_API_ALLOW_LOCALHOST", "1")
    assert client.endpoint_refusal(url)


@pytest.mark.parametrize("url", ["http://localhost:8080/v30/analyze", "http://127.0.0.1:9/x", "https://127.0.0.1/x",
                                 "http://[::1]:8080/x"])
def test_local_gateway_needs_switch(url, monkeypatch):
    assert "ZN_API_ALLOW_LOCALHOST=1" in client.endpoint_refusal(url)
    monkeypatch.setenv("ZN_API_ALLOW_LOCALHOST", "true")
    assert "ZN_API_ALLOW_LOCALHOST=1" in client.endpoint_refusal(url)
    monkeypatch.setenv("ZN_API_ALLOW_LOCALHOST", "1")
    assert client.endpoint_refusal(url) is None


def test_analyze_with_env_url_to_another_host_sends_nothing(monkeypatch, capsys):
    monkeypatch.setenv("ZN_API_KEY", FAKE_KEY)
    monkeypatch.setenv("ZN_CLOUD", "1")
    monkeypatch.setenv("ZN_API_URL", "http://collector.example.invalid/analyze")
    with mock.patch.object(client, "_open") as opened:
        res = client.analyze(TEXT)
    opened.assert_not_called()
    assert res["fallback"] is True
    assert "only sent to https://api.usezn.com" in res["cloud_error"]
    assert FAKE_KEY not in str(res)
    err = capsys.readouterr().err
    assert "not allowed" in err and FAKE_KEY not in err


def test_analyze_cloud_refuses_before_sending():
    with mock.patch.object(client, "_open") as opened, pytest.raises(client.EndpointRefusedError):
        client.analyze_cloud(TEXT, FAKE_KEY, "https://collector.example.invalid/x")
    opened.assert_not_called()


def _server(handler):
    srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
    srv.seen = []
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_redirect_is_not_followed(monkeypatch):
    monkeypatch.setenv("ZN_API_ALLOW_LOCALHOST", "1")

    class Target(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.server.seen.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            self.do_POST()

        def log_message(self, *a):
            pass

    target = _server(Target)
    location = "http://127.0.0.1:%d/collect" % target.server_port

    class Redirect(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.send_response(307)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a):
            pass

    first = _server(Redirect)
    try:
        with pytest.raises(urllib.error.HTTPError) as info:
            client.analyze_cloud(TEXT, FAKE_KEY, "http://127.0.0.1:%d/v30/analyze" % first.server_port, timeout=3)
        info.value.close()
        assert info.value.code == 307
    finally:
        for s in (first, target):
            s.shutdown()
            s.server_close()
    assert target.seen == []
