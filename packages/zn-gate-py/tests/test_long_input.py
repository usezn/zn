"""Long texts ask the cloud gate for overlapping windows ("long_input": "windows").

A local HTTP server stands in for the gate; nothing leaves the machine.
"""
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from zn_gate.client import LONG_INPUT_MIN_CHARS, analyze, long_input_mode

KEY = "zn_test_" + "a1b2c3d4e5f6a7b8c9d0e1f2"
# Neutral filler text: no rule fires on it.
SENTENCE = "The quarterly report lists the shipping dates for each warehouse. "


class _Gate:
    def __init__(self, reply):
        seen = self.seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
                seen.append(body)
                data = json.dumps(reply(body)).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/v30/analyze" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _allow(body):
    n = len(body["input"])
    out = {"verdict": "allow", "confidence": 0.1, "input_chars": n, "billed_calls": max(1, 1 + -(-(n - 2000) // 1000))}
    if body.get("long_input") == "windows":
        out["long_input"] = {"mode": "windows", "windows": 3, "top_window": 2, "capped": False}
    return out


CLOUD = {"ZN_CLOUD": "1", "ZN_LOCAL_ONLY": ""}


class LongInputTests(unittest.TestCase):
    def test_long_text_asks_for_windows_short_text_unchanged(self):
        gate = _Gate(_allow)
        self.addCleanup(gate.close)
        with mock.patch.dict(os.environ, CLOUD):
            os.environ.pop("ZN_LONG_INPUT", None)
            text = SENTENCE * 40
            self.assertGreater(len(text), LONG_INPUT_MIN_CHARS)
            res = analyze(text, api_key=KEY, endpoint=gate.url)
            self.assertEqual(res["mode"], "hybrid-cloud", res)
            self.assertEqual(gate.seen[0]["long_input"], "windows")
            self.assertEqual(res["long_input"]["windows"], 3)
            # The gate's billing fields reach the caller unchanged.
            self.assertEqual(res["billed_calls"], 2)
            self.assertEqual(res["input_chars"], len(text))
            self.assertNotIn("warning", res)
            analyze(SENTENCE, api_key=KEY, endpoint=gate.url)
            self.assertEqual(list(gate.seen[1].keys()), ["input"])

    def test_off_keeps_the_first_512_tokens_request(self):
        gate = _Gate(_allow)
        self.addCleanup(gate.close)
        with mock.patch.dict(os.environ, dict(CLOUD, ZN_LONG_INPUT="off")):
            analyze(SENTENCE * 40, api_key=KEY, endpoint=gate.url)
            self.assertNotIn("long_input", gate.seen[0])
        with mock.patch.dict(os.environ, dict(CLOUD, ZN_LONG_INPUT="windows")):
            analyze(SENTENCE * 40, api_key=KEY, endpoint=gate.url, long_input="off")
            self.assertNotIn("long_input", gate.seen[1])
        self.assertEqual(long_input_mode("OFF"), "off")
        self.assertEqual(long_input_mode("windows"), "windows")

    def test_capped_answer_adds_a_warning(self):
        gate = _Gate(lambda body: {"verdict": "allow", "confidence": 0.1,
                                   "long_input": {"mode": "windows", "windows": 20, "top_window": 0, "capped": True}})
        self.addCleanup(gate.close)
        with mock.patch.dict(os.environ, CLOUD):
            os.environ.pop("ZN_LONG_INPUT", None)
            res = analyze(SENTENCE * 300, api_key=KEY, endpoint=gate.url)
        self.assertIn("end was not analyzed", res["warning"])

    def test_fallback_answer_adds_a_warning(self):
        gate = _Gate(lambda body: {"verdict": "allow", "confidence": 0.1,
                                   "long_input": {"mode": "truncate", "reason": "fallback"}})
        self.addCleanup(gate.close)
        with mock.patch.dict(os.environ, CLOUD):
            os.environ.pop("ZN_LONG_INPUT", None)
            res = analyze(SENTENCE * 40, api_key=KEY, endpoint=gate.url)
        self.assertIn("only the first 512 tokens of this text (fallback)", res["warning"])

    def test_without_the_cloud_nothing_is_sent(self):
        gate = _Gate(_allow)
        self.addCleanup(gate.close)
        with mock.patch.dict(os.environ, {"ZN_CLOUD": ""}):
            res = analyze(SENTENCE * 40, api_key=KEY, endpoint=gate.url)
        self.assertEqual(res["mode"], "oss-local")
        self.assertEqual(gate.seen, [])


if __name__ == "__main__":
    unittest.main()
