"""With ZN_CLOUD=1 and the cloud unreachable, `analyze` keeps the local result and exit code and prints one
short line on stderr (no URL, key or text). A library call prints nothing. Nothing leaves the machine:
the transport is a fake urlopen, and 192.0.2.1 is a reserved documentation address."""

import contextlib
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

from zn_gate import cli, client

KEY = "zn_test_" + "a1b2c3d4e5f6a7b8c9d0e1f2"
TEXT = "The quarterly report lists the shipping dates for each warehouse."
URL = "https://192.0.2.1/v30/analyze"
LINE_START = "zn-gate: cloud check unavailable ("
LINE_END = "); using the local result\n"


class TestCliCloudFallbackNotice(unittest.TestCase):
    def _env(self, **extra):
        env = {"ZN_API_KEY": KEY, "ZN_CLOUD": "1", "ZN_API_URL": URL}
        env.update(extra)
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)
        for k in ("ZN_LOCAL_ONLY", "ZN_VERBOSE", "DEBUG"):
            if k not in extra:
                os.environ.pop(k, None)

    def _cli(self, opener=None):
        out, err = io.StringIO(), io.StringIO()
        if opener is None:
            opener = mock.Mock(side_effect=urllib.error.URLError(OSError("unreachable")))
        with mock.patch.object(sys, "argv", ["zn-gate", "analyze", TEXT]), \
                mock.patch.object(client.urllib.request, "urlopen", opener), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main()
        return code, json.loads(out.getvalue()), err.getvalue()

    def test_one_line_and_same_result(self):
        self._env()
        code, res, err = self._cli()
        self.assertEqual(code, 0)
        self.assertEqual(res["verdict"], "allow")
        self.assertIs(res["fallback"], True)
        self.assertEqual(res["mode"], "oss-local-fallback")
        self.assertTrue(err.startswith(LINE_START) and err.endswith(LINE_END), err)
        self.assertEqual(err.count("\n"), 1)
        self.assertIn("(could not connect)", err)

    def test_line_has_no_secret_url_or_text(self):
        self._env()
        _, _, err = self._cli()
        for leak in (KEY, "192.0.2.1", "quarterly"):
            self.assertNotIn(leak, err)

    def test_http_error_reason(self):
        self._env()
        e = urllib.error.HTTPError(URL, 503, "x", {}, io.BytesIO(b"{}"))
        _, _, err = self._cli(mock.Mock(side_effect=e))
        self.assertIn("(HTTP 503)", err)

    def test_no_line_without_cloud(self):
        self._env(ZN_CLOUD="0")
        code, res, err = self._cli()
        self.assertEqual((code, err), (0, ""))
        self.assertNotIn("fallback", res)

    def test_verbose_prints_detail_not_second_line(self):
        self._env(ZN_VERBOSE="1")
        _, _, err = self._cli()
        self.assertIn("Cloud gate error", err)
        self.assertNotIn(LINE_START, err)

    def test_library_call_prints_nothing(self):
        self._env()
        err = io.StringIO()
        opener = mock.Mock(side_effect=urllib.error.URLError(OSError("x")))
        with mock.patch.object(client.urllib.request, "urlopen", opener), contextlib.redirect_stderr(err):
            res = client.analyze(TEXT, timeout=0.2)
        self.assertIs(res["fallback"], True)
        self.assertEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
