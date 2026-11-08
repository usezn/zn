"""stats --json prints the same top-level keys with zero events as with one event."""

import datetime
import json
import sys
from unittest import mock

from zn_gate import cli


def _stats_json(capsys):
    with mock.patch.object(sys, "argv", ["zn-gate", "stats", "--json"]):
        assert cli.main() == 0
    return json.loads(capsys.readouterr().out)


def test_empty_home_has_the_same_keys_as_one_event(tmp_path, monkeypatch, capsys):
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("ZN_HOME", str(empty))
    no_events = _stats_json(capsys)

    one = tmp_path / "one"
    one.mkdir()
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    counts = {"checked": 1, "blocked": 0, "warned": 0, "redacted": 0}
    stats = {"version": 1, "days": {today: {"agent:claude": counts}}, "events": {}}
    (one / "stats.json").write_text(json.dumps(stats), encoding="utf-8")
    monkeypatch.setenv("ZN_HOME", str(one))
    with_event = _stats_json(capsys)

    assert set(no_events) == set(with_event)
    assert no_events["total"]["checked"] == 0
    assert with_event["total"]["checked"] == 1
