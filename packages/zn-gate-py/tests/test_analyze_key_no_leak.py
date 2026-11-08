# The Python analyze client never returns, raises or logs the API key it was given.
# A real local HTTP server (127.0.0.1 only, no network) answers the cloud call with a 200, a 401, a 500 whose body
# echoes the Authorization header, or an answer that comes too late. The key is a fake value.
# Each result is checked as a dict, as repr and str, in JSON, in every exception of the chain, and in logging,
# stdout and stderr.

import http.server
import json
import logging
import threading
import time
import urllib.error

import pytest

from zn_gate import client

FAKE_KEY = "zn_test_FAKEKEY000"
TEXT = "The quarterly report lists the shipping dates for each warehouse."
ALLOW = {"verdict": "allow", "confidence": 0.9, "rule": "none"}
BLOCK = {"verdict": "block", "confidence": 0.97, "rule": "fake:rule"}


def _serve(status, reply, echo=False, delay=0.0):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.server.seen.append(self.headers.get("Authorization"))
            if delay:
                time.sleep(delay)
            if echo:
                payload = json.dumps({"error": "internal", "authorization": self.headers.get("Authorization")}).encode("utf-8")
            else:
                payload = json.dumps(reply).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.daemon_threads = True
    srv.seen = []
    srv.handle_error = lambda request, client_address: None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d/v30/analyze" % srv.server_port


def _chain_texts(exc):
    texts, seen = [], set()
    cur = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        texts += [str(cur), repr(cur)]
        cur = cur.__cause__ or cur.__context__
    return texts


SCENARIOS = [
    pytest.param(200, ALLOW, False, 0.0, 4.0, False, id="200-allow"),
    pytest.param(200, BLOCK, False, 0.0, 4.0, False, id="200-block"),
    pytest.param(401, {"error": "unauthorized"}, False, 0.0, 4.0, True, id="401"),
    pytest.param(500, None, True, 0.0, 4.0, True, id="500-echoes-headers"),
    pytest.param(200, ALLOW, False, 1.0, 0.2, True, id="timeout"),
]


@pytest.mark.parametrize("status,reply,echo,delay,timeout,fallback", SCENARIOS)
def test_analyze_result_and_output_never_contain_the_key(status, reply, echo, delay, timeout, fallback, monkeypatch, capsys, caplog):
    monkeypatch.setenv("ZN_CLOUD", "1")
    monkeypatch.setenv("ZN_VERBOSE", "1")
    monkeypatch.delenv("ZN_LOCAL_ONLY", raising=False)
    monkeypatch.delenv("ZN_API_URL", raising=False)
    srv, url = _serve(status, reply, echo=echo, delay=delay)
    try:
        with caplog.at_level(logging.DEBUG):
            result = client.analyze(TEXT, api_key=FAKE_KEY, endpoint=url, timeout=timeout)
    finally:
        srv.shutdown()
        srv.server_close()
    assert srv.seen == ["Bearer " + FAKE_KEY]
    assert bool(result.get("fallback")) is fallback
    assert result["mode"] == ("oss-local-fallback" if fallback else "hybrid-cloud")
    captured = capsys.readouterr()
    if fallback:
        assert "Cloud gate error" in captured.err
    for text in [str(result), repr(result), json.dumps(result, default=str), captured.out, captured.err, caplog.text]:
        assert FAKE_KEY not in text


@pytest.mark.parametrize("status,reply,echo,delay,timeout", [
    pytest.param(401, {"error": "unauthorized"}, False, 0.0, 4.0, id="401"),
    pytest.param(500, None, True, 0.0, 4.0, id="500-echoes-headers"),
    pytest.param(200, ALLOW, False, 1.0, 0.2, id="timeout"),
])
def test_transport_exceptions_do_not_carry_the_key(status, reply, echo, delay, timeout):
    srv, url = _serve(status, reply, echo=echo, delay=delay)
    try:
        with pytest.raises(Exception) as info:
            client.analyze_cloud(TEXT, FAKE_KEY, url, timeout=timeout)
    finally:
        srv.shutdown()
        srv.server_close()
    if isinstance(info.value, urllib.error.HTTPError):
        # The HTTP error holds the open response: close it so the socket is not left to the garbage collector.
        info.value.close()
    assert srv.seen == ["Bearer " + FAKE_KEY]
    for text in _chain_texts(info.value) + [client.cloud_error_hint(info.value)]:
        assert FAKE_KEY not in text
