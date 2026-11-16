"""The Python CLI takes only full long option names.

argparse accepts any unique prefix of a long option by default, so `scan DIR --allow`
used to mean `--allow-partial` and could exit 0 with files that were never read.
"""

import sys

import pytest

from zn_gate import cli


def _run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["zn-gate", *argv])
    return cli.main()


@pytest.mark.parametrize(
    "argv_tail",
    [
        ["scan", "{dir}", "--allow"],
        ["scan", "{dir}", "--no"],
        ["evidence", "--ver"],
        ["analyze", "hello", "--local"],
        ["stats", "--da", "7"],
        ["--vers"],
    ],
)
def test_abbreviated_long_option_is_an_argparse_error(monkeypatch, capsys, tmp_path, argv_tail):
    (tmp_path / "unread.py").write_text("print('not a prompt')\n")
    argv = [a.format(dir=str(tmp_path)) for a in argv_tail]
    with pytest.raises(SystemExit) as exc:
        _run(monkeypatch, *argv)
    assert exc.value.code == 2
    assert "unrecognized arguments" in capsys.readouterr().err


def test_full_option_names_still_work(monkeypatch, tmp_path):
    (tmp_path / "notes.md").write_text("A harmless note with no instructions.\n")
    assert _run(monkeypatch, "scan", str(tmp_path), "--format", "json", "--no-fail") == 0
    assert _run(monkeypatch, "scan", str(tmp_path), "--format=json", "--allow-partial") == 0
    assert _run(monkeypatch, "test", "Summarize the quarterly revenue report.", "--json") == 0
