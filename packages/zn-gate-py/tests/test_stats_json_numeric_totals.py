"""zn-gate stats --json: the totals of a populated stats file are integers and add up across days and keys."""

import datetime
import json
import sys
from unittest import mock

from zn_gate import cli


def test_populated_stats_totals_are_ints_and_match(tmp_path, monkeypatch, capsys):
    today = datetime.datetime.now(datetime.timezone.utc).date()
    yesterday = today - datetime.timedelta(days=1)
    days = {
        today.isoformat(): {
            "agent:claude": {"checked": 4, "blocked": 1, "warned": 0, "redacted": 2},
            "mcp:scan": {"checked": 3, "blocked": 0, "warned": 1, "redacted": 0},
        },
        yesterday.isoformat(): {
            "agent:claude": {"checked": 5, "blocked": 2, "warned": 1, "redacted": 0},
        },
    }
    home = tmp_path / "home"
    home.mkdir()
    (home / "stats.json").write_text(json.dumps({"version": 1, "days": days, "events": {}}), encoding="utf-8")
    monkeypatch.setenv("ZN_HOME", str(home))

    with mock.patch.object(sys, "argv", ["zn-gate", "stats", "--json"]):
        assert cli.main() == 0
    out = json.loads(capsys.readouterr().out)

    assert out["total"] == {"checked": 12, "blocked": 3, "warned": 2, "redacted": 2}
    for field, value in out["total"].items():
        assert type(value) is int, field
    assert out["byKey"]["agent:claude"] == {"checked": 9, "blocked": 3, "warned": 1, "redacted": 2}
    assert out["byKey"]["mcp:scan"] == {"checked": 3, "blocked": 0, "warned": 1, "redacted": 0}
