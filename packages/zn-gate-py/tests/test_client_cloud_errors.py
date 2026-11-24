"""
Cloud errors in the Python client: HTTP 401, 429 and 500, a body that is not
JSON, a timeout and a refused connection. analyze() must never raise; it
returns the documented local fallback result. The transport is a fake urlopen;
nothing here opens a socket.
"""

import io
import json
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


def _http_error(code, reason, body=b"{}"):
    return urllib.error.HTTPError(ENDPOINT, code, reason, {}, io.BytesIO(body))


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
        with mock.patch.object(client, "_open", opener):
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

    def test_http_error_response_is_closed(self):
        # The error carries the open response; leaving it to the GC keeps the socket open
        # and Python 3.14 warns "Implicitly cleaning up HTTPError".
        body = io.BytesIO(b"{}")
        err = urllib.error.HTTPError(ENDPOINT, 503, "unavailable", {}, body)
        self._assert_fallback(self._run(self._raising(err)), "503")
        self.assertTrue(body.closed)

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

    def test_failed_cloud_call_never_shows_the_api_key(self):
        # Patched for this test only, so verbose mode cannot reach another test.
        patcher = mock.patch.dict(os.environ, {"ZN_VERBOSE": "1"})
        patcher.start()
        self.addCleanup(patcher.stop)
        failures = {
            "http_500": _http_error(500, "Server Error"),
            "connection_refused": urllib.error.URLError(ConnectionRefusedError(111, "Connection refused")),
        }
        for name, err in failures.items():
            with self.subTest(failure=name):
                stderr = io.StringIO()
                with mock.patch("sys.stderr", stderr):
                    res = self._run(self._raising(err))
                self.assertIs(res["fallback"], True)
                # The verbose warning is written, so the stderr check is not vacuous.
                self.assertIn("Cloud gate error", stderr.getvalue())
                self.assertNotIn(FAKE_KEY, json.dumps(res))
                self.assertNotIn(FAKE_KEY, stderr.getvalue())

    def test_banned_account_403_gets_its_own_hint(self):
        err = _http_error(403, "Forbidden", b'{"error": "Account suspended", "code": "account_banned"}')
        res = self._run(self._raising(err))
        self._assert_fallback(res, "403")
        self.assertIn("suspended", client.cloud_error_hint(err))
        self.assertIn("contact support", client.cloud_error_hint(err))
        self.assertNotIn("API key", client.cloud_error_hint(err))

    def test_other_403_keeps_the_api_key_hint(self):
        bodies = {
            "other_code": b'{"code": "something_else"}',
            "no_code": b'{"error": "Forbidden"}',
            "empty": b"",
            "not_json": b"<html>Forbidden</html>",
            "json_list": b"[1, 2]",
            "code_not_string": b'{"code": 5}',
            "banned_on_401": None,
        }
        for name, body in bodies.items():
            with self.subTest(body=name):
                if body is None:
                    err = _http_error(401, "Unauthorized", b'{"code": "account_banned"}')
                else:
                    err = _http_error(403, "Forbidden", body)
                res = self._run(self._raising(err))
                self._assert_fallback(res)
                self.assertIn("did not accept the API key", client.cloud_error_hint(err))

    def test_oversized_error_body_is_not_read_fully(self):
        class _Counting(io.BytesIO):
            total = 0

            def read(self, n=-1):
                data = super().read(n)
                _Counting.total += len(data)
                return data

        body = _Counting(b'{"code": "account_banned", "pad": "' + b"x" * 1_000_000 + b'"}')
        err = urllib.error.HTTPError(ENDPOINT, 403, "Forbidden", {}, body)
        res = self._run(self._raising(err))
        self._assert_fallback(res, "403")
        self.assertLess(_Counting.total, 10_000)
        self.assertTrue(body.closed)
        self.assertIn("did not accept the API key", client.cloud_error_hint(err))

    def test_banned_hint_never_shows_the_key_or_the_body(self):
        err = _http_error(403, "Forbidden", b'{"code": "account_banned", "detail": "secret-detail-xyz"}')
        res = self._run(self._raising(err))
        hint = client.cloud_error_hint(err)
        for text in (hint, json.dumps(res)):
            self.assertNotIn(FAKE_KEY, text)
            self.assertNotIn("secret-detail-xyz", text)

    def test_banned_error_that_cannot_be_read_does_not_raise(self):
        class _Broken(io.BytesIO):
            def read(self, n=-1):
                raise OSError("connection reset")

        err = urllib.error.HTTPError(ENDPOINT, 403, "Forbidden", {}, _Broken(b""))
        self._assert_fallback(self._run(self._raising(err)), "403")
        self.assertIn("did not accept the API key", client.cloud_error_hint(err))

    def test_fallback_keeps_no_cloud_fields(self):
        res = self._run(self._raising(_http_error(500, "Server Error")))
        self.assertNotIn("secrets_redacted_before_upload", res)
        self.assertNotEqual(res["mode"], "hybrid-cloud")


if __name__ == "__main__":
    unittest.main()
