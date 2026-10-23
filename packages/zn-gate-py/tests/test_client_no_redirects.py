"""The Python cloud client must never follow a redirect: the API key would
travel to another host. Uses two local servers on 127.0.0.1; fake key only."""
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from zn_gate import client

FAKE_KEY = "zn_live_FAKEKEY0000000000000000000000000000"


def _serve(handler_cls):
    srv = HTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class TestNoRedirects(unittest.TestCase):
    def setUp(self):
        self.hits = []
        hits = self.hits

        class Target(BaseHTTPRequestHandler):
            def do_POST(self):
                hits.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"verdict": "block"}')

            do_GET = do_POST

            def log_message(self, *a):
                pass

        self.target = _serve(Target)
        self.addCleanup(self.target.server_close)
        self.addCleanup(self.target.shutdown)
        env = {"ZN_API_KEY": FAKE_KEY, "ZN_CLOUD": "1"}
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)
        os.environ.pop("ZN_LOCAL_ONLY", None)

    def _redirector(self, code):
        dest = "http://127.0.0.1:%d/steal" % self.target.server_port

        class Redir(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(code)
                self.send_header("Location", dest)
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = _serve(Redir)
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return "http://127.0.0.1:%d/v30/analyze" % srv.server_port

    def test_redirects_are_not_followed(self):
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code):
                self.hits.clear()
                res = client.analyze("Please summarize this README for me.",
                                     endpoint=self._redirector(code))
                self.assertEqual(self.hits, [], "second host received a request")
                self.assertTrue(res.get("fallback"))
                self.assertEqual(res["mode"], "oss-local-fallback")
                self.assertEqual(res["verdict"], "allow")
                self.assertTrue(res.get("cloud_error"))

    def test_analyze_cloud_raises_on_redirect(self):
        import urllib.error
        with self.assertRaises(urllib.error.HTTPError):
            client.analyze_cloud("hi", FAKE_KEY, self._redirector(302))
        self.assertEqual(self.hits, [])

    def test_normal_200_still_works(self):
        url = "http://127.0.0.1:%d/v30/analyze" % self.target.server_port
        res = client.analyze("Please summarize this README for me.", endpoint=url)
        self.assertEqual(res["mode"], "hybrid-cloud")
        self.assertEqual(res["verdict"], "block")
        self.assertEqual(self.hits, ["Bearer " + FAKE_KEY])


if __name__ == "__main__":
    unittest.main()
