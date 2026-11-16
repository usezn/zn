"""A cloud answer whose decided_by starts with "ml-error" was decided by the rules alone (the model was down). It keeps
the cloud verdict and is marked degraded so the caller can tell it apart. The transport is a fake urlopen; nothing here
opens a socket."""

import contextlib
import io
import json
import os
import unittest
from unittest import mock

from zn_gate import cli, client

FAKE_KEY = "fake-key-for-tests"
ENDPOINT = "https://example.com/v30/analyze"
TEXT = "The quarterly report lists the shipping dates for each warehouse."
REASON = "model unavailable, rules only"
WARN = "the cloud model was unavailable, so this verdict comes from the cloud gate fallback rules, not from its model"
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


class TestCloudDegraded(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for k in ZN_VARS:
            os.environ.pop(k, None)
        os.environ["ZN_API_KEY"] = FAKE_KEY
        os.environ["ZN_CLOUD"] = "1"

    def _reply(self, reply):
        raw = json.dumps(reply).encode("utf-8")

        def opener(req, timeout=None):
            return _Resp(raw)

        return opener

    def _analyze(self, reply):
        with mock.patch.object(client.urllib.request, "urlopen", self._reply(reply)):
            return client.analyze(TEXT, endpoint=ENDPOINT)

    def test_ml_error_is_degraded_and_keeps_the_verdict(self):
        for decided_by in ("ml-error", "ml-error-timeout", "ML-ERROR: model down"):
            res = self._analyze({"verdict": "allow", "confidence": 0.2, "rule": "none", "decided_by": decided_by})
            self.assertEqual(res["mode"], "hybrid-cloud", decided_by)
            self.assertEqual(res["verdict"], "allow", decided_by)
            self.assertIs(res["degraded"], True, decided_by)
            self.assertEqual(res["degraded_reason"], REASON, decided_by)
            self.assertNotIn("fallback", res, decided_by)

    def test_degraded_block_keeps_the_block(self):
        res = self._analyze({"verdict": "block", "confidence": 0.9, "rule": "neural", "decided_by": "ml-error"})
        self.assertEqual(res["verdict"], "block")
        self.assertEqual(res["rule"], "neural")
        self.assertIs(res["degraded"], True)

    def test_normal_answer_has_no_degraded_field(self):
        for reply in (
            {"verdict": "allow", "confidence": 0.01, "rule": "none", "decided_by": "ml"},
            {"verdict": "block", "confidence": 0.99, "rule": "neural", "decided_by": "hybrid-cloud"},
            {"verdict": "allow", "confidence": 0.01, "rule": "none"},
        ):
            res = self._analyze(reply)
            self.assertEqual(res["mode"], "hybrid-cloud", reply)
            self.assertNotIn("degraded", res, reply)
            self.assertNotIn("degraded_reason", res, reply)

    def test_cli_prints_one_warning_line_only_when_degraded(self):
        def run(reply):
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.object(client.urllib.request, "urlopen", self._reply(reply)), \
                    mock.patch("sys.argv", ["zn-gate", "analyze", TEXT]), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                cli.main()
            return json.loads(out.getvalue()), err.getvalue()

        res, err = run({"verdict": "allow", "confidence": 0.2, "rule": "none", "decided_by": "ml-error"})
        self.assertIs(res["degraded"], True)
        self.assertEqual(sum(WARN in line for line in err.splitlines()), 1, err)

        res, err = run({"verdict": "allow", "confidence": 0.01, "rule": "none", "decided_by": "ml"})
        self.assertNotIn("degraded", res)
        self.assertNotIn(WARN, err)


if __name__ == "__main__":
    unittest.main()
