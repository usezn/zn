"""`zn-gate analyze` with an invalid ZN_API_URL.

The cloud endpoint is read only when the user opted in (ZN_API_KEY and ZN_CLOUD=1).
No test here reaches the network: urllib.request.urlopen is replaced by a recorder
that raises, so any request the product tries to make is recorded instead of sent.
The two expectedFailure tests describe the wanted behaviour (a clear error that names
ZN_API_URL and a non-zero exit, before any request). They fail today because the
product falls back silently to the local rules with exit 0; the error text only sits
inside the JSON field "cloud_error". Remove the decorator when that is fixed.
"""

import contextlib
import io
import os
import unittest
from unittest import mock

from zn_gate import cli

FAKE_KEY = "zn_test_key_not_real"
TEXT = "Please summarize the quarterly revenue report."
INVALID_URLS = ["not a url", "http//missing-colon"]
UNSUPPORTED_SCHEME = "ftp://example.com/analyze"


def _run(api_url):
    """Run the CLI in-process with cloud opted in. Returns (rc, stdout, stderr, requested_urls)."""
    env = {"ZN_API_KEY": FAKE_KEY, "ZN_CLOUD": "1", "ZN_API_URL": api_url}
    requested = []

    def blocked_urlopen(request, *args, **kwargs):
        requested.append(getattr(request, "full_url", request))
        raise OSError("network blocked in tests")

    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env), \
            mock.patch("urllib.request.urlopen", side_effect=blocked_urlopen), \
            mock.patch("sys.argv", ["zn_gate", "analyze", TEXT]), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        os.environ.pop("ZN_LOCAL_ONLY", None)
        os.environ.pop("ZN_STAGE", None)
        try:
            rc = cli.main()
        except SystemExit as exc:
            rc = exc.code
    return rc, out.getvalue(), err.getvalue(), requested


class TestHarness(unittest.TestCase):
    def test_request_hook_sees_a_valid_url(self):
        # Control: proves the recorder catches a request, so the "no request" checks mean something.
        _, _, _, requested = _run("https://example.com/analyze")
        self.assertEqual(requested, ["https://example.com/analyze"])


class TestInvalidApiUrl(unittest.TestCase):
    def test_invalid_url_prints_no_traceback(self):
        for value in INVALID_URLS + [UNSUPPORTED_SCHEME]:
            rc, out, err, _ = _run(value)
            self.assertNotIn("Traceback", out + err, msg=f"traceback for ZN_API_URL={value!r}")

    @unittest.expectedFailure
    def test_invalid_url_is_reported_by_name(self):
        # Wanted: non-zero exit and an error on stderr that names ZN_API_URL.
        for value in INVALID_URLS:
            rc, out, err, requested = _run(value)
            self.assertEqual(requested, [], msg=f"request attempted for ZN_API_URL={value!r}")
            self.assertNotEqual(rc, 0, msg=f"exit 0 for ZN_API_URL={value!r}")
            self.assertIn("ZN_API_URL", err, msg=f"no ZN_API_URL in stderr for {value!r}")

    @unittest.expectedFailure
    def test_unsupported_scheme_fails_before_any_request(self):
        # Wanted: ftp:// is rejected before urlopen runs, with a non-zero exit naming ZN_API_URL.
        rc, out, err, requested = _run(UNSUPPORTED_SCHEME)
        self.assertEqual(requested, [], msg="request attempted for an ftp:// ZN_API_URL")
        self.assertNotEqual(rc, 0)
        self.assertIn("ZN_API_URL", err)


if __name__ == "__main__":
    unittest.main()
