"""zn-gate scan reports the real line number of a secret in a file with CRLF
line endings: here line 3 of a 4-line file. The key is invented and built at
runtime."""
import argparse
import io
import json
from contextlib import redirect_stdout

from zn_gate import cli

FAKE_AWS = "AKIA" + "ZNTESTFAKE" + "000000"


def test_scan_reports_line_3_for_a_key_in_a_crlf_file(tmp_path):
    lines = ["first line", "second line", "aws_key = " + FAKE_AWS, "fourth line"]
    (tmp_path / "notes.md").write_bytes(("\r\n".join(lines) + "\r\n").encode("utf-8"))
    ns = argparse.Namespace(path=str(tmp_path), format="json", no_fail=True, allow_partial=False,
                            include=None, exclude=None)
    buf = io.StringIO()
    with redirect_stdout(buf):
        cli.cmd_scan(ns)
    out = buf.getvalue()
    data = json.loads(out)
    secret_lines = sorted({t["line"] for t in data["threats"] if t["type"] == "secret_leak"})
    assert secret_lines == [3]
    assert FAKE_AWS not in out
