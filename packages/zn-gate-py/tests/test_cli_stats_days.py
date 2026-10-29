"""The stats command and its --days range (1 to the number of days kept), text and JSON output."""

import json
import sys
from unittest import mock

import pytest

from zn_gate import cli, stats

KEEP = stats.KEEP_DAYS


def _main(argv):
    with mock.patch.object(sys, "argv", ["zn-gate", *argv]):
        return cli.main()


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))


@pytest.mark.parametrize("days", [0, KEEP + 1, -1])
@pytest.mark.parametrize("extra", [[], ["--json"]])
def test_out_of_range_days_exit_2_with_message(days, extra, capsys):
    assert _main(["stats", "--days", str(days), *extra]) == 2
    captured = capsys.readouterr()
    assert captured.err == "zn-gate stats: --days must be between 1 and {}\n".format(KEEP)
    assert captured.out == ""


@pytest.mark.parametrize("days", [1, KEEP])
def test_edge_days_are_accepted_as_json(days, capsys):
    assert _main(["stats", "--days", str(days), "--json"]) == 0
    captured = capsys.readouterr()
    data = json.loads(captured.out)
    assert data["days"] == days
    assert captured.err == ""


def test_default_days_json_is_valid(capsys):
    assert _main(["stats", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["days"] == 30


@pytest.mark.parametrize("days", [1, KEEP])
def test_edge_days_text_output(days, capsys):
    assert _main(["stats", "--days", str(days)]) == 0
    out = capsys.readouterr().out
    assert out.strip()
    assert "last {} day".format(days) in out
