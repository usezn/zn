"""The command line exit code follows the cloud verdict contract: a verdict other than "allow" or "block" (another
word, another type) blocks and exits 2, never 0. A local HTTP server in a thread stands in for the gate."""

import contextlib
import http.server
import io
import json
import os
import sys
import threading
import unittest
from unittest import mock

from zn_gate import cli

KEY = "zn_test_" + "a1b2c3d4e5f6a7b8c9d0e1f2"
TEXT = "The quarterly report lists the shipping dates for each warehouse."


def _gate(reply):
    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            body = json.dumps(reply).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d/v30/analyze" % srv.server_port


class TestCliCloudVerdictExit(unittest.TestCase):
    def _run(self, reply):
        srv, url = _gate(reply)
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        env = {"ZN_API_KEY": KEY, "ZN_CLOUD": "1", "ZN_API_URL": url}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), mock.patch.object(sys, "argv", ["zn-gate", "analyze", TEXT]), \
                contextlib.redirect_stdout(out):
            os.environ.pop("ZN_LOCAL_ONLY", None)
            code = cli.main()
        return code, json.loads(out.getvalue())

    def test_unknown_word_blocks_and_exits_2(self):
        code, res = self._run({"verdict": "DENY", "confidence": 0.99, "rule": "fake:attack"})
        self.assertEqual(code, 2)
        self.assertEqual((res["verdict"], res["rule"]), ("block", "cloud:unknown-verdict"))

    def test_wrong_type_blocks_and_exits_2(self):
        code, res = self._run({"verdict": 1, "confidence": 0.99, "rule": "neural"})
        self.assertEqual(code, 2)
        self.assertEqual(res["verdict"], "block")

    def test_allow_exits_0(self):
        code, res = self._run({"verdict": "Allow", "confidence": 0.01, "rule": "none"})
        self.assertEqual(code, 0)
        self.assertEqual(res["verdict"], "allow")


if __name__ == "__main__":
    unittest.main()
