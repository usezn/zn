"""
The Python client has no settings file loader: its settings are the options
passed as keyword arguments plus environment variables. These tests pin that
unknown keys, values of the wrong type and empty settings (an empty dict, or
the content of an empty settings file) fall back to defaults and never raise.
Settings read from a temporary file are fed in as options. No network is used.
"""

import json
import os
import tempfile
import unittest
from unittest import mock

from zn_gate import client

ZN_VARS = ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_URL", "ZN_STAGE", "ZN_LONG_INPUT")


class TestSettingsTolerance(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for k in ZN_VARS:
            os.environ.pop(k, None)

    def _load(self, text):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "settings.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            with open(path, encoding="utf-8") as fh:
                raw = fh.read()
        return json.loads(raw) if raw.strip() else {}

    def test_empty_settings_file_gives_defaults(self):
        opts = self._load("")
        self.assertEqual(client.resolve_endpoint(opts), client.DEFAULT_ENDPOINT)
        res = client.analyze("hello there", **opts)
        self.assertEqual(res["verdict"], "allow")
        self.assertEqual(res["mode"], "oss-local")

    def test_empty_dict_and_none_give_defaults(self):
        self.assertEqual(client.resolve_endpoint({}), client.DEFAULT_ENDPOINT)
        self.assertEqual(client.resolve_endpoint(None), client.DEFAULT_ENDPOINT)

    def test_unknown_keys_are_ignored(self):
        opts = self._load(json.dumps({"colour": "blue", "retries": 3, "nested": {"a": [1]}}))
        self.assertEqual(client.resolve_endpoint(opts), client.DEFAULT_ENDPOINT)
        res = client.analyze("hello there", **opts)
        self.assertEqual(res["mode"], "oss-local")

    def test_unknown_keys_do_not_hide_known_ones(self):
        opts = {"colour": "blue", "stage": "prod"}
        self.assertEqual(client.resolve_endpoint(opts), "https://api.usezn.com/prod/analyze")

    def test_wrong_type_stage_falls_back_to_default(self):
        for bad in (5, ["prod"], {"a": 1}, True, 1.5):
            with self.subTest(bad=bad):
                self.assertEqual(client.resolve_endpoint({"stage": bad}), client.DEFAULT_ENDPOINT)

    def test_falsy_wrong_type_api_url_falls_through(self):
        for bad in (0, None, False, [], {}):
            with self.subTest(bad=bad):
                self.assertEqual(client.resolve_endpoint({"api_url": bad}), client.DEFAULT_ENDPOINT)

    def test_wrong_type_api_url_does_not_raise(self):
        client.resolve_endpoint({"api_url": 123})
        client.resolve_endpoint({"api_url": ["x"]})

    def test_wrong_type_long_input_means_windows(self):
        for bad in (5, ["off"], {"a": 1}, 1.5):
            with self.subTest(bad=bad):
                self.assertEqual(client.long_input_mode(bad), "windows")

    def test_wrong_type_options_in_analyze_stay_local(self):
        res = client.analyze("hello there", stage=7, api_url=None, long_input=3, colour="blue")
        self.assertEqual(res["verdict"], "allow")
        self.assertEqual(res["mode"], "oss-local")


if __name__ == "__main__":
    unittest.main()
