"""
Settings precedence in the Python client: endpoint choice, the cloud opt-in
switches, and the long-input window threshold. The transport is a fake
urlopen; nothing here opens a socket.
"""

import json
import os
import unittest
from unittest import mock

from zn_gate import client

KEY_ENV = "zn_test_" + "env_key_0000"
KEY_ARG = "zn_test_" + "arg_key_0000"
ZN_VARS = ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_URL", "ZN_STAGE", "ZN_LONG_INPUT")
LIMIT = client.LONG_INPUT_MIN_CHARS


class _Resp:
    def read(self):
        return json.dumps({"verdict": "allow", "confidence": 0.1}).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Case(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for k in ZN_VARS:
            os.environ.pop(k, None)
        self.calls = []

    def _open(self, req, timeout=None):
        self.calls.append({
            "url": req.full_url,
            "timeout": timeout,
            "auth": req.get_header("Authorization"),
            "body": json.loads(req.data.decode("utf-8")),
        })
        return _Resp()

    def run_analyze(self, text="hello there", **kw):
        with mock.patch.object(client.urllib.request, "urlopen", self._open):
            return client.analyze(text, **kw)


class TestEndpointPrecedence(_Case):
    def test_empty_option_falls_through_to_env(self):
        os.environ["ZN_API_URL"] = "https://example.com/from-env"
        self.assertEqual(client.resolve_endpoint({"api_url": ""}), "https://example.com/from-env")

    def test_empty_env_falls_through_to_stage(self):
        os.environ["ZN_API_URL"] = ""
        os.environ["ZN_STAGE"] = "prod"
        self.assertEqual(client.resolve_endpoint(), "https://api.usezn.com/prod/analyze")

    def test_url_beats_stage(self):
        os.environ["ZN_API_URL"] = "https://example.com/from-env"
        self.assertEqual(client.resolve_endpoint({"stage": "prod"}), "https://example.com/from-env")

    def test_stage_option_beats_env_stage(self):
        os.environ["ZN_STAGE"] = "prod"
        self.assertEqual(client.resolve_endpoint({"stage": "v30"}), client.DEFAULT_ENDPOINT)

    def test_unknown_stage_uses_default(self):
        self.assertEqual(client.resolve_endpoint({"stage": "staging"}), client.DEFAULT_ENDPOINT)

    def test_analyze_endpoint_argument_beats_everything(self):
        os.environ.update(ZN_API_KEY=KEY_ENV, ZN_CLOUD="1", ZN_API_URL="https://example.com/env/v30/analyze")
        self.run_analyze(endpoint="https://example.com/arg/v30/analyze", api_url="https://example.com/kw/v30/analyze")
        self.assertEqual(self.calls[0]["url"], "https://example.com/arg/v30/analyze")

    def test_analyze_api_url_keyword_beats_env(self):
        os.environ.update(ZN_API_KEY=KEY_ENV, ZN_CLOUD="1", ZN_API_URL="https://example.com/env/v30/analyze")
        self.run_analyze(api_url="https://example.com/kw/v30/analyze")
        self.assertEqual(self.calls[0]["url"], "https://example.com/kw/v30/analyze")

    def test_analyze_uses_env_url_then_stage(self):
        os.environ.update(ZN_API_KEY=KEY_ENV, ZN_CLOUD="1", ZN_API_URL="https://example.com/env/v30/analyze")
        res = self.run_analyze()
        self.assertEqual(self.calls[0]["url"], "https://example.com/env/v30/analyze")
        self.assertEqual(res["engine"], "cloud-v30")
        del os.environ["ZN_API_URL"]
        res = self.run_analyze(stage="prod")
        self.assertEqual(self.calls[1]["url"], "https://api.usezn.com/prod/analyze")
        self.assertEqual(res["engine"], "cloud-prod")


class TestCloudSwitches(_Case):
    def test_api_key_argument_beats_env_key(self):
        os.environ.update(ZN_API_KEY=KEY_ENV, ZN_CLOUD="1")
        self.run_analyze(api_key=KEY_ARG, endpoint="https://example.com/v30/analyze")
        self.assertEqual(self.calls[0]["auth"], "Bearer " + KEY_ARG)
        self.run_analyze(endpoint="https://example.com/v30/analyze")
        self.assertEqual(self.calls[1]["auth"], "Bearer " + KEY_ENV)

    def test_only_exact_one_opts_in(self):
        os.environ["ZN_API_KEY"] = KEY_ENV
        for value in ("", "0", "true", "yes", "11", " 1"):
            os.environ["ZN_CLOUD"] = value
            self.assertFalse(client.is_cloud_enabled(), value)
        os.environ["ZN_CLOUD"] = "1"
        self.assertTrue(client.is_cloud_enabled())

    def test_only_exact_true_forces_local(self):
        os.environ.update(ZN_API_KEY=KEY_ENV, ZN_CLOUD="1")
        for value in ("", "1", "TRUE", "True", "yes", "false"):
            os.environ["ZN_LOCAL_ONLY"] = value
            self.assertTrue(client.is_cloud_enabled(), value)
        os.environ["ZN_LOCAL_ONLY"] = "true"
        self.assertFalse(client.is_cloud_enabled())

    def test_local_only_argument_beats_opt_in(self):
        os.environ.update(ZN_API_KEY=KEY_ENV, ZN_CLOUD="1")
        res = self.run_analyze(local_only=True, endpoint="https://example.com/v30/analyze")
        self.assertEqual(self.calls, [])
        self.assertEqual(res["mode"], "oss-local")
        self.assertEqual(res["verdict"], "allow")

    def test_local_only_env_beats_key_argument(self):
        os.environ.update(ZN_CLOUD="1", ZN_LOCAL_ONLY="true")
        res = self.run_analyze(api_key=KEY_ARG, endpoint="https://example.com/v30/analyze")
        self.assertEqual(self.calls, [])
        self.assertEqual(res["mode"], "oss-local")

    def test_missing_or_empty_key_disables_cloud(self):
        os.environ["ZN_CLOUD"] = "1"
        self.assertFalse(client.is_cloud_enabled(None))
        self.assertFalse(client.is_cloud_enabled(""))


class TestWindowThreshold(_Case):
    def setUp(self):
        super().setUp()
        os.environ.update(ZN_API_KEY=KEY_ENV, ZN_CLOUD="1")

    def _ask(self, text, **kw):
        self.run_analyze(text, endpoint="https://example.com/v30/analyze", **kw)
        return self.calls[-1]

    def test_boundary_is_strictly_greater_than_the_limit(self):
        at_limit = self._ask("a" * LIMIT)
        self.assertEqual(list(at_limit["body"]), ["input"])
        self.assertEqual(at_limit["timeout"], 4.0)
        over = self._ask("a" * (LIMIT + 1))
        self.assertEqual(over["body"]["long_input"], "windows")
        self.assertEqual(over["timeout"], client.WINDOWS_TIMEOUT)

    def test_length_counts_utf16_units(self):
        # 501 astral characters are 501 code points but 1002 UTF-16 units.
        text = "\U0001F600" * 501
        self.assertLess(len(text), LIMIT)
        self.assertEqual(self._ask(text)["body"]["long_input"], "windows")
        self.assertNotIn("long_input", self._ask("\U0001F600" * 500)["body"])

    def test_env_off_disables_windows_and_argument_overrides_env(self):
        os.environ["ZN_LONG_INPUT"] = "off"
        call = self._ask("a" * (LIMIT + 500))
        self.assertNotIn("long_input", call["body"])
        self.assertEqual(call["timeout"], 4.0)
        call = self._ask("a" * (LIMIT + 500), long_input="windows")
        self.assertEqual(call["body"]["long_input"], "windows")

    def test_explicit_timeout_wins_for_long_text(self):
        call = self._ask("a" * (LIMIT + 500), timeout=2.5)
        self.assertEqual(call["timeout"], 2.5)
        self.assertEqual(call["body"]["long_input"], "windows")

    def test_threshold_uses_redacted_text_length(self):
        # Redaction shortens this fake key assignment, so a raw text just over
        # the limit falls to the limit once redacted and gets no windows.
        secret = "AKIA" + "ZNTESTFAKE" + "000000"
        tail = " AWS_ACCESS_KEY_ID=" + secret
        shrink = len(tail) - len(client.redact_secrets(tail)[0])
        self.assertGreater(shrink, 0)
        text = "a" * (LIMIT + shrink - len(tail)) + tail
        self.assertEqual(len(text), LIMIT + shrink)
        call = self._ask(text)
        self.assertNotIn("long_input", call["body"])
        self.assertNotIn(secret, call["body"]["input"])


if __name__ == "__main__":
    unittest.main()
