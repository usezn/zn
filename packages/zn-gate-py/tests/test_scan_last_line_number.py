"""zn-gate scan reports the real line number of a secret on the last line of a
long file: here line 1000 of a 1000-line file. The key is invented and built at
runtime."""
import argparse
import io
import json
from contextlib import redirect_stdout

from zn_gate import cli

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"
LINES = 1000


def test_scan_reports_line_1000_for_a_key_on_the_last_line(tmp_path):
    body = ["filler line number %d" % i for i in range(1, LINES)]
    body.append("aws_key = " + FAKE_AWS)
    (tmp_path / "notes.md").write_text("\n".join(body) + "\n", encoding="utf-8", newline="")
    ns = argparse.Namespace(path=str(tmp_path), format="json", no_fail=True, allow_partial=False,
                            include=None, exclude=None)
    buf = io.StringIO()
    with redirect_stdout(buf):
        cli.cmd_scan(ns)
    out = buf.getvalue()
    data = json.loads(out)
    secret_lines = sorted({t["line"] for t in data["threats"] if t["type"] == "secret_leak"})
    assert secret_lines == [LINES]
    assert FAKE_AWS not in out
