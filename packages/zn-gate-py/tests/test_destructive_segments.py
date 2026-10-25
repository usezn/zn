"""Behaviour of the command splitter and the pipe check in destructive.py."""
import pytest

from zn_gate.destructive import _is_pipe, _segments_of


@pytest.mark.parametrize("cmd,sep", [
    ("a;b", ";"),
    ("a && b", "&&"),
    ("a || b", "||"),
    ("a | b", "|"),
    ("a |& b", "|&"),
    ("a\nb", "\n"),
])
@pytest.mark.parametrize("posix", [False, True])
def test_splits_on_separator(cmd, sep, posix):
    segs, truncated = _segments_of(cmd, posix)
    assert segs == [(["a"], sep), (["b"], None)]
    assert truncated is False


@pytest.mark.parametrize("cmd,words", [
    ("echo 'a;b'", ["echo", "a;b"]),
    ('echo "a&&b|c"', ["echo", "a&&b|c"]),
    ("echo 'a||b'", ["echo", "a||b"]),
    ('echo "a\nb"', ["echo", "a\nb"]),
])
def test_separators_inside_quotes_do_not_split(cmd, words):
    assert _segments_of(cmd) == ([(words, None)], False)


def test_empty_segment_between_separators():
    assert _segments_of("a;;b")[0] == [(["a"], ";"), ([], ";"), (["b"], None)]
    assert _segments_of("a\n\nb")[0] == [(["a"], "\n"), ([], "\n"), (["b"], None)]


def test_leading_separator_gives_empty_first_segment():
    assert _segments_of("; a")[0] == [([], ";"), (["a"], None)]


@pytest.mark.parametrize("cmd,sep", [("a;", ";"), ("a |", "|"), ("a &&", "&&"), ("a\n", "\n")])
def test_trailing_separator_adds_no_empty_segment(cmd, sep):
    assert _segments_of(cmd) == ([(["a"], sep)], False)


def test_empty_input():
    assert _segments_of("") == ([], False)


@pytest.mark.parametrize("sep,expected", [
    ("|", True), ("|&", True), ("||", False), (";", False),
    ("&&", False), ("&", False), ("\n", False), (None, False),
])
def test_is_pipe(sep, expected):
    assert _is_pipe(sep) is expected
