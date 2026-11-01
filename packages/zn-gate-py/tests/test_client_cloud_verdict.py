"""
The cloud verdict is read without case or spaces where it is parsed, and an
unknown one blocks (fail closed). The transport is a fake urlopen; nothing here
opens a socket.
"""

import json
import os
import unittest
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


class TestCloudVerdict(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for k in ZN_VARS:
            os.environ.pop(k, None)
        os.environ["ZN_API_KEY"] = FAKE_KEY
        os.environ["ZN_CLOUD"] = "1"

    def _run(self, reply):
        raw = json.dumps(reply).encode("utf-8")

        def opener(req, timeout=None):
            return _Resp(raw)

        with mock.patch.object(client.urllib.request, "urlopen", opener):
            return client.analyze("The quarterly report lists the shipping dates.", endpoint=ENDPOINT)

    def test_case_and_spaces(self):
        for v, want in (("BLOCK", "block"), ("Block", "block"), (" block ", "block"), ("Allow", "allow"), ("ALLOW", "allow"), ("allow", "allow")):
            res = self._run({"verdict": v, "confidence": 0.5, "rule": "neural"})
            self.assertEqual(res["verdict"], want, v)
            self.assertEqual(res["rule"], "neural", v)
            self.assertEqual(res["mode"], "hybrid-cloud", v)

    def test_unknown_verdict_blocks(self):
        for reply in ({"verdict": "maybe"}, {"verdict": ""}, {"verdict": None}, {"verdict": 1}, {"confidence": 0.2}):
            res = self._run(reply)
            self.assertEqual(res["verdict"], "block", reply)
            self.assertEqual(res["rule"], "cloud:unknown-verdict", reply)

    def test_helper_on_non_objects(self):
        for body in (None, [], "block", 7):
            with self.assertRaises(TypeError):
                client._cloud_verdict(body)


if __name__ == "__main__":
    unittest.main()
