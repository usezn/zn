"""`zn-gate stats` with no stats file (empty ZN_HOME) exits 0 and prints a clear line, in text and JSON."""

import json
import sys
from unittest import mock

from zn_gate import cli


def _main(argv, capsys):
    with mock.patch.object(sys, "argv", ["zn-gate", *argv]):
        code = cli.main()
    out = capsys.readouterr()
    return code, out.out, out.err


def test_stats_text_with_no_stats_file_exits_zero_and_says_nothing_recorded(tmp_path, monkeypatch, capsys):
    home = tmp_path / "empty-home"
    home.mkdir()
    monkeypatch.setenv("ZN_HOME", str(home))
    assert not (home / "stats.json").exists()

    code, out, err = _main(["stats"], capsys)

    assert code == 0
    assert err == ""
    assert "Nothing recorded yet" in out
    assert "last 30 days" in out
    assert not (home / "stats.json").exists(), "reading stats must not create the file"


def test_stats_json_with_no_stats_file_exits_zero_with_zero_totals(tmp_path, monkeypatch, capsys):
    home = tmp_path / "empty-home"
    home.mkdir()
    monkeypatch.setenv("ZN_HOME", str(home))

    code, out, err = _main(["stats", "--json"], capsys)

    assert code == 0
    assert err == ""
    data = json.loads(out)
    assert data["total"] == {"checked": 0, "blocked": 0, "warned": 0, "redacted": 0}
    assert data["byKey"] == {}
