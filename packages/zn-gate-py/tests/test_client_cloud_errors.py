"""
Cloud errors in the Python client: HTTP 401, 429 and 500, a body that is not
JSON, a timeout and a refused connection. analyze() must never raise; it
returns the documented local fallback result. The transport is a fake urlopen;
nothing here opens a socket.
"""

import io
import os
import socket
import unittest
import urllib.error
from unittest import mock

from zn_gate import client

FAKE_KEY = "fake-key-for-tests"
ENDPOINT = "https://example.com/v30/analyze"
ZN_VARS = ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_URL", "ZN_STAGE", "ZN_LONG_INPUT", "ZN_VERBOSE", "DEBUG")


class _Resp:
    def __init__(self, raw):
        self._raw = raw

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http_error(code, reason):
    return urllib.error.HTTPError(ENDPOINT, code, reason, {}, io.BytesIO(b"{}"))


class TestCloudErrors(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for k in ZN_VARS:
            os.environ.pop(k, None)
        os.environ["ZN_API_KEY"] = FAKE_KEY
        os.environ["ZN_CLOUD"] = "1"

    def _run(self, opener):
        with mock.patch.object(client.urllib.request, "urlopen", opener):
            return client.analyze("hello there", endpoint=ENDPOINT)

    def _raising(self, err):
        def opener(req, timeout=None):
            raise err
        return opener

    def _assert_fallback(self, res, fragment=None):
        self.assertEqual(res["verdict"], "allow")
        self.assertEqual(res["rule"], "none")
        self.assertIsNone(res["reason"])
        self.assertEqual(res["mode"], "oss-local-fallback")
        self.assertEqual(res["engine"], "oss-local")
        self.assertIs(res["fallback"], True)
        self.assertIsInstance(res["cloud_error"], str)
        self.assertTrue(res["cloud_error"])
        if fragment:
            self.assertIn(fragment, res["cloud_error"])

    def test_http_401(self):
        self._assert_fallback(self._run(self._raising(_http_error(401, "Unauthorized"))), "401")

    def test_http_429(self):
        self._assert_fallback(self._run(self._raising(_http_error(429, "Too Many Requests"))), "429")

    def test_http_500(self):
        self._assert_fallback(self._run(self._raising(_http_error(500, "Server Error"))), "500")

    def test_body_not_json(self):
        res = self._run(lambda r, timeout=None: _Resp(b"<html>not json</html>"))
        self._assert_fallback(res)

    def test_timeout(self):
        self._assert_fallback(self._run(self._raising(socket.timeout("timed out"))))

    def test_url_error_timeout(self):
        self._assert_fallback(self._run(self._raising(urllib.error.URLError(socket.timeout("timed out")))))

    def test_connection_refused(self):
        err = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        self._assert_fallback(self._run(self._raising(err)), "refused")

    def test_bare_connection_refused(self):
        self._assert_fallback(self._run(self._raising(ConnectionRefusedError(111, "Connection refused"))), "refused")

    def test_fallback_keeps_no_cloud_fields(self):
        res = self._run(self._raising(_http_error(500, "Server Error")))
        self.assertNotIn("secrets_redacted_before_upload", res)
        self.assertNotEqual(res["mode"], "hybrid-cloud")


if __name__ == "__main__":
    unittest.main()
