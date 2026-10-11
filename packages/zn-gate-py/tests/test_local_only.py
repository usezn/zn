"""
1.4.1 data-flow guarantees (Python SDK):
- with ZN_API_KEY but without ZN_CLOUD=1, analyze() makes no network request;
- with ZN_API_KEY + ZN_CLOUD=1, the uploaded text is secret-redacted;
- tool results are sanitized locally and never sent.
Secrets are invented values with a valid format, assembled at runtime so
secret scanners don't flag this file.
"""

import json
import os
import unittest
from unittest import mock

from zn_gate import analyze, sanitize_tool_result, is_cloud_enabled
from zn_gate.guard import check_tool_result

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"
FAKE_GH = "ghp_" + "zntestfake" * 3 + "abcdef"
FAKE_KEY = "zn_test_" + "notarealkey_0000"
BLOB = f"Current settings:\nAWS_ACCESS_KEY_ID={FAKE_AWS}\ntoken: {FAKE_GH}\n"
ZN_VARS = ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_URL")


class _FakeResp:
    def read(self):
        return json.dumps({"verdict": "allow", "confidence": 0.9}).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestLocalOnly(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        for k in ZN_VARS:
            os.environ.pop(k, None)

    def tearDown(self):
        self._env.stop()

    def test_key_without_zn_cloud_sends_nothing(self):
        os.environ["ZN_API_KEY"] = FAKE_KEY
        with mock.patch("urllib.request.urlopen") as up:
            self.assertFalse(is_cloud_enabled())
            res = analyze("Please summarize this README for me.")
            self.assertEqual(res["mode"], "oss-local")
            self.assertNotIn("tip", res)
            res2 = analyze("hello", api_key=FAKE_KEY)
            self.assertEqual(res2["mode"], "oss-local")
            up.assert_not_called()

    def test_local_only_wins_over_zn_cloud(self):
        os.environ.update(ZN_API_KEY=FAKE_KEY, ZN_CLOUD="1", ZN_LOCAL_ONLY="true")
        with mock.patch("urllib.request.urlopen") as up:
            analyze("Please summarize this README for me.")
            up.assert_not_called()

    def test_zn_cloud_upload_is_redacted(self):
        os.environ.update(ZN_API_KEY=FAKE_KEY, ZN_CLOUD="1")
        with mock.patch("urllib.request.urlopen", return_value=_FakeResp()) as up:
            res = analyze(f"Please review these settings. {BLOB}")
            self.assertEqual(res["mode"], "hybrid-cloud")
            self.assertGreaterEqual(res["secrets_redacted_before_upload"], 2)
            self.assertEqual(up.call_count, 1)
            body = up.call_args[0][0].data.decode()
            self.assertNotIn(FAKE_AWS, body)
            self.assertNotIn(FAKE_GH, body)
            self.assertIn("[REDACTED", body)

    def test_tool_results_never_sent_and_redacted(self):
        os.environ.update(ZN_API_KEY=FAKE_KEY, ZN_CLOUD="1")
        with mock.patch("urllib.request.urlopen") as up:
            out = sanitize_tool_result("read_file", BLOB)
            self.assertNotIn(FAKE_AWS, out["sanitized_content"])
            self.assertNotIn(FAKE_GH, out["sanitized_content"])
            check_tool_result(BLOB)
            up.assert_not_called()


if __name__ == "__main__":
    unittest.main()
