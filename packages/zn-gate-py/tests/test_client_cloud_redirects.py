"""
Cloud client hardening: a redirect is never followed (the API key never reaches a second URL), endpoints that are not
https are refused (plain http only to this machine), and the key must have the shape the Node.js client accepts.
Servers here listen on 127.0.0.1 only; nothing leaves the machine.
"""

import http.server
import json
import os
import threading
import unittest
import urllib.error
from unittest import mock

from zn_gate import client

KEY = "zn_test_" + "notarealkey_0000"
ZN_VARS = ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_URL", "ZN_STAGE", "ZN_LONG_INPUT", "ZN_VERBOSE", "DEBUG")


class _Server:
    def __init__(self, handler_cls):
        self.hits = []
        outer = self

        class H(handler_cls):
            def log_message(self, *a):
                pass

            def _note(self):
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    self.rfile.read(n)
                outer.hits.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization")})

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path="/v30/analyze"):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class _Target(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self._note()
        body = json.dumps({"verdict": "allow"}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST


def _redirector(location, code):
    class R(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self._note()
            self.send_response(code)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = do_POST

    return R


class TestCloudRedirects(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(os.environ, {}, clear=False)
        p.start()
        self.addCleanup(p.stop)
        for k in ZN_VARS:
            os.environ.pop(k, None)

    def test_redirect_not_followed_key_stays_on_first_server(self):
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code):
                second = _Server(_Target)
                first = _Server(_redirector(second.url("/steal"), code))
                self.addCleanup(second.close)
                self.addCleanup(first.close)
                with self.assertRaises(urllib.error.HTTPError) as cm:
                    client.analyze_cloud("hello there", KEY, first.url())
                cm.exception.close()
                self.assertEqual(cm.exception.code, code)
                self.assertEqual(len(first.hits), 1)
                self.assertEqual(second.hits, [])

    def test_analyze_falls_back_locally_on_redirect(self):
        second = _Server(_Target)
        first = _Server(_redirector(second.url("/steal"), 302))
        self.addCleanup(second.close)
        self.addCleanup(first.close)
        os.environ["ZN_API_KEY"] = KEY
        os.environ["ZN_CLOUD"] = "1"
        res = client.analyze("hello there", endpoint=first.url())
        self.assertEqual(res["mode"], "oss-local-fallback")
        self.assertTrue(res["fallback"])
        self.assertEqual(second.hits, [])
        self.assertNotIn(KEY, json.dumps(res))

    def test_http_loopback_still_works(self):
        srv = _Server(_Target)
        self.addCleanup(srv.close)
        res = client.analyze_cloud("hello there", KEY, srv.url())
        self.assertEqual(res["verdict"], "allow")
        self.assertEqual(srv.hits[0]["auth"], "Bearer " + KEY)


class TestEndpointRefused(unittest.TestCase):
    def _refused(self, url):
        opener = mock.Mock()
        with mock.patch.object(client, "_open", opener):
            with self.assertRaises(ValueError):
                client.analyze_cloud("hello there", KEY, url)
        opener.assert_not_called()

    def test_http_to_other_hosts(self):
        for url in ("http://example.com/v30/analyze", "http://192.0.2.1/v30/analyze",
                    "http://localhost.example.com/x", "http://127.0.0.1.example.com/x"):
            with self.subTest(url=url):
                self._refused(url)

    def test_other_schemes(self):
        for url in ("file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi", "gopher://example.com/", "example.com/x"):
            with self.subTest(url=url):
                self._refused(url)

    def test_https_without_host(self):
        self._refused("https:///v30/analyze")

    def test_analyze_reports_refusal_as_fallback(self):
        os.environ["ZN_API_KEY"] = KEY
        os.environ["ZN_CLOUD"] = "1"
        opener = mock.Mock()
        with mock.patch.object(client, "_open", opener):
            res = client.analyze("hello there", endpoint="file:///etc/passwd")
        opener.assert_not_called()
        self.assertEqual(res["mode"], "oss-local-fallback")
        self.assertTrue(res["fallback"])


class TestKeyShape(unittest.TestCase):
    def test_bad_keys_refused_before_any_request(self):
        for key in ("", "short", "x" * 15, "x" * 257, "has space inside key1", "zn_test_key\nwith_newline_1", "${user_config.api_key}",
                    "%ZN_API_KEY%", "clé_non_ascii_0000000"):
            with self.subTest(key=key[:20]):
                opener = mock.Mock()
                with mock.patch.object(client, "_open", opener):
                    with self.assertRaises(ValueError):
                        client.analyze_cloud("hello there", key, "https://example.com/v30/analyze")
                opener.assert_not_called()

    def test_edge_lengths_accepted(self):
        for key in ("k" * 16, "k" * 256, "  " + "k" * 16 + "  "):
            with self.subTest(n=len(key)):
                resp = mock.MagicMock()
                resp.__enter__.return_value.read.return_value = b'{"verdict": "allow"}'
                opener = mock.Mock(return_value=resp)
                with mock.patch.object(client, "_open", opener):
                    res = client.analyze_cloud("hello there", key, "https://example.com/v30/analyze")
                self.assertEqual(res["verdict"], "allow")
                req = opener.call_args[0][0]
                self.assertEqual(req.get_header("Authorization"), "Bearer " + key.strip())

    def test_valid_https_builds_request(self):
        resp = mock.MagicMock()
        resp.__enter__.return_value.read.return_value = b'{"verdict": "block"}'
        opener = mock.Mock(return_value=resp)
        with mock.patch.object(client, "_open", opener):
            res = client.analyze_cloud("hello there", KEY, "https://api.usezn.com/v30/analyze")
        req = opener.call_args[0][0]
        self.assertEqual(req.full_url, "https://api.usezn.com/v30/analyze")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(res["engine"], "cloud-v30")

    def test_opener_has_no_redirect_following(self):
        client._OPENER = None
        client._open  # noqa: B018 (opener is built lazily on first call)
        opener = __import__("urllib.request").request.build_opener(client._BoundedHTTPSHandler, client._NoRedirectHandler)
        handlers = [type(h) for h in opener.handlers]
        self.assertIn(client._NoRedirectHandler, handlers)
        self.assertNotIn(__import__("urllib.request").request.HTTPRedirectHandler, handlers)


if __name__ == "__main__":
    unittest.main()
