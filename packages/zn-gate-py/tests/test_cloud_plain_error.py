"""analyze_cloud raises CloudGateError, a URLError with a plain message and the next step, instead of a raw
URLError or HTTPError; analyze() puts the same text in cloud_error. Only local addresses and fake keys are used."""

import http.server
import json
import socket
import threading
import urllib.error

import pytest

from zn_gate import client


def _server(status, body=b"{}"):
    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/v1/analyze"


@pytest.mark.parametrize("status,text", [
    (401, "did not accept the API key (HTTP 401). Check ZN_API_KEY, or run zn-gate status."),
    (429, "asked to slow down (HTTP 429)"),
    (503, "answered with an error (HTTP 503)"),
])
def test_http_errors_are_plain_and_still_url_errors(status, text):
    srv, url = _server(status)
    try:
        with pytest.raises(client.CloudGateError) as info:
            client.analyze_cloud("hello", "zn-test-fake-0000", url, timeout=5)
    finally:
        srv.shutdown()
    assert text in str(info.value)
    assert info.value.code == status
    assert isinstance(info.value, urllib.error.URLError)


def test_unreachable_and_unreadable():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with pytest.raises(client.CloudGateError) as info:
        client.analyze_cloud("hello", "zn-test-fake-0000", f"http://127.0.0.1:{port}/v1/analyze", timeout=2)
    assert "could not be reached" in str(info.value)
    assert "Errno" not in str(info.value)
    srv, url = _server(200, b"not json")
    try:
        with pytest.raises(client.CloudGateError) as info:
            client.analyze_cloud("hello", "zn-test-fake-0000", url, timeout=5)
    finally:
        srv.shutdown()
    assert "could not be read" in str(info.value)
    assert isinstance(info.value, ValueError), "a bad answer is still a ValueError"


def test_analyze_puts_the_plain_text_in_cloud_error(monkeypatch):
    srv, url = _server(401)
    monkeypatch.setenv("ZN_CLOUD", "1")
    monkeypatch.delenv("ZN_LOCAL_ONLY", raising=False)
    try:
        res = client.analyze("What is the weather in Madrid?", api_key="zn-test-fake-0000", endpoint=url)
    finally:
        srv.shutdown()
    assert res["fallback"] is True
    assert res["cloud_error"].startswith("the cloud gate did not accept the API key (HTTP 401)"), json.dumps(res)
