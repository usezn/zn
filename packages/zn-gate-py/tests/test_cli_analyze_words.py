"""analyze: several words and a missing text."""
import json
import sys

from zn_gate import cli


def _run(monkeypatch, capsys, *argv):
    monkeypatch.setattr(sys, "argv", ["zn-gate", "analyze", "--local-only", *argv])
    code = cli.main()
    return code, capsys.readouterr()


def test_unquoted_words_are_joined(monkeypatch, capsys):
    code, out = _run(monkeypatch, capsys, "hello", "there", "friend")
    assert code in (0, 1)
    assert "unrecognized arguments" not in out.err
    assert json.loads(out.out)


def test_quoted_text_is_the_same_as_unquoted(monkeypatch, capsys):
    _, a = _run(monkeypatch, capsys, "hello there friend")
    _, b = _run(monkeypatch, capsys, "hello", "there", "friend")
    ja, jb = json.loads(a.out), json.loads(b.out)
    for j in (ja, jb):
        j.pop("latency_ms", None)
    assert ja == jb


def test_no_text_gives_a_hint_and_exit_2(monkeypatch, capsys):
    code, out = _run(monkeypatch, capsys)
    assert code == 2
    assert out.out == ""
    assert 'zn-gate analyze "' in out.err and "double quotes" in out.err
    assert "Traceback" not in out.err
