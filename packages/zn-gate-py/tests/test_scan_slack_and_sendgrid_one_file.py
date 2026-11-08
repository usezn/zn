"""zn-gate scan reports a Slack bot token and a SendGrid key that sit in the
same file, each on its own line, and never prints either value. Both values are
invented and built at runtime from fragments, so no real-looking secret is in
this source file."""
import argparse
import io
import json
from contextlib import redirect_stdout

from zn_gate import cli

_BODY = "Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj0Ks"


def _body(n):
    return "".join(_BODY[i % len(_BODY)] for i in range(n))


FAKE_SLACK = "xox" + "b-" + "1234567890" + "-" + "1234567890123" + "-" + _body(24)
FAKE_SENDGRID = "SG" + "." + _body(22) + "." + _body(43)


def _scan(tmp_path):
    (tmp_path / "config.txt").write_text(
        "slack_bot = " + FAKE_SLACK + "\nmail_key = " + FAKE_SENDGRID + "\n", encoding="utf-8")
    ns = argparse.Namespace(path=str(tmp_path), format="json", no_fail=True, allow_partial=False,
                            include=None, exclude=None)
    buf = io.StringIO()
    with redirect_stdout(buf):
        cli.cmd_scan(ns)
    return buf.getvalue()


def test_scan_reports_slack_token_and_sendgrid_key_on_their_own_lines(tmp_path):
    out = _scan(tmp_path)
    secrets = [t for t in json.loads(out)["threats"] if t["type"] == "secret_leak"]
    assert {(t["line"], t["rule"]) for t in secrets} == {
        (1, "secret:slack_token"),
        (2, "secret:sendgrid_key"),
    }


def test_scan_output_does_not_contain_either_value(tmp_path):
    out = _scan(tmp_path)
    assert FAKE_SLACK not in out
    assert FAKE_SENDGRID not in out
