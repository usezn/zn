"""cmd_stats: the --days range check and the --json switch (temporary ZN_HOME, no network)."""

import argparse
import datetime
import json

import pytest

from zn_gate import cli, stats

DAYS_ERROR = "zn-gate stats: --days must be between 1 and 90\n"


@pytest.fixture
def zn_home(tmp_path, monkeypatch):
    home = tmp_path / "zn-home"
    home.mkdir()
    monkeypatch.setenv("ZN_HOME", str(home))
    return home


def write_stats(home, checked):
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    data = {
        "version": 1,
        "days": {today: {"hook:example-agent": {"checked": checked, "blocked": 1, "warned": 0, "redacted": 2}}},
        "events": {},
    }
    (home / "stats.json").write_text(json.dumps(data), encoding="utf-8")


@pytest.mark.parametrize("days", [0, 91, -1, "x", None])
def test_days_out_of_range_returns_2_with_message(zn_home, capsys, days):
    assert cli.cmd_stats(argparse.Namespace(days=days, json=False)) == 2
    captured = capsys.readouterr()
    assert captured.err == DAYS_ERROR
    assert captured.out == ""


@pytest.mark.parametrize("days", [0, 91, -1, "x", None])
def test_days_out_of_range_also_rejected_with_json(zn_home, capsys, days):
    assert cli.cmd_stats(argparse.Namespace(days=days, json=True)) == 2
    captured = capsys.readouterr()
    assert captured.err == DAYS_ERROR
    assert captured.out == ""


def test_error_message_names_the_keep_window():
    assert DAYS_ERROR == "zn-gate stats: --days must be between 1 and {}\n".format(stats.KEEP_DAYS)


@pytest.mark.parametrize("days", [1, 90])
def test_days_at_the_bounds_return_0(zn_home, capsys, days):
    assert cli.cmd_stats(argparse.Namespace(days=days, json=False)) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    assert captured.out


def test_json_true_prints_parsable_json(zn_home, capsys):
    write_stats(zn_home, 5)
    assert cli.cmd_stats(argparse.Namespace(days=7, json=True)) == 0
    out = capsys.readouterr().out
    data = json.loads(out)
    assert data["days"] == 7
    assert data["total"]["checked"] == 5
    assert data["total"]["redacted"] == 2
    assert "hook:example-agent" in data["byKey"]


def test_json_true_with_empty_home_is_still_json(zn_home, capsys):
    assert cli.cmd_stats(argparse.Namespace(days=30, json=True)) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["total"] == {"checked": 0, "blocked": 0, "warned": 0, "redacted": 0}
    assert data["since"] is None


def test_json_false_prints_rendered_summary(zn_home, capsys):
    write_stats(zn_home, 5)
    assert cli.cmd_stats(argparse.Namespace(days=7, json=False)) == 0
    out = capsys.readouterr().out
    assert out == stats.render(stats.summary(days=7))
    assert out.startswith("zn-gate on this machine, last 7 days")
    assert "5 events checked" in out
    with pytest.raises(ValueError):
        json.loads(out)


def test_json_false_with_empty_home_says_nothing_recorded(zn_home, capsys):
    assert cli.cmd_stats(argparse.Namespace(days=1, json=False)) == 0
    out = capsys.readouterr().out
    assert "last 1 day:" in out
    assert "Nothing recorded yet." in out
