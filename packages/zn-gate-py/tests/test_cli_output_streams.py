"""Console output helpers in zn_gate.cli: _configure_output_streams, _plain_text and _icon.

Covers a UTF-8 stream, a cp1252 stream, a stream whose error handler is not
"strict", NO_COLOR and a stream that is not a terminal.
"""

import io
import sys
from types import SimpleNamespace
from unittest import mock

import pytest

from zn_gate import cli


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("NO_COLOR", "TERM", "CI"):
        monkeypatch.delenv(name, raising=False)


def _wrapper(encoding, errors="strict"):
    raw = io.BytesIO()
    return raw, io.TextIOWrapper(raw, encoding=encoding, errors=errors, newline="\n")


def _configure(stream):
    with mock.patch.object(sys, "stdout", stream), mock.patch.object(sys, "stderr", stream):
        cli._configure_output_streams()


def _terminal(encoding):
    return SimpleNamespace(encoding=encoding, isatty=lambda: True)


# ---------------------------------------------------- _configure_output_streams

def test_utf8_strict_stream_keeps_encoding_and_writes_symbols_unchanged():
    raw, stream = _wrapper("utf-8")
    _configure(stream)
    assert stream.encoding == "utf-8"
    assert stream.errors == "replace"
    stream.write(f"{cli.SHIELD} café\n")
    stream.flush()
    assert raw.getvalue() == f"{cli.SHIELD} café\n".encode("utf-8")


def test_cp1252_strict_stream_replaces_what_it_cannot_encode():
    raw, stream = _wrapper("cp1252")
    _configure(stream)
    assert stream.encoding == "cp1252"
    assert stream.errors == "replace"
    stream.write(f"{cli.CHECK} café\n")
    stream.flush()
    assert raw.getvalue() == "? café\n".encode("cp1252")


def test_cp1252_strict_stream_raises_without_configuration():
    _, stream = _wrapper("cp1252")
    with pytest.raises(UnicodeEncodeError):
        stream.write(cli.CHECK)


@pytest.mark.parametrize("errors", ["backslashreplace", "ignore", "replace"])
def test_stream_with_other_error_handler_is_left_as_is(errors):
    _, stream = _wrapper("cp1252", errors)
    _configure(stream)
    assert stream.errors == errors


def test_stream_with_other_error_handler_is_not_reconfigured():
    stream = mock.Mock(errors="surrogateescape")
    _configure(stream)
    stream.reconfigure.assert_not_called()


def test_strict_stream_is_reconfigured_with_replace_only():
    stream = mock.Mock(errors="strict")
    _configure(stream)
    stream.reconfigure.assert_called_with(errors="replace")


# ------------------------------------------------------------------ _plain_text

def test_plain_text_is_off_by_default():
    assert cli._plain_text() is False


@pytest.mark.parametrize("value", ["1", "true", "0", "anything"])
def test_plain_text_is_on_for_any_non_empty_no_color(monkeypatch, value):
    monkeypatch.setenv("NO_COLOR", value)
    assert cli._plain_text() is True


def test_plain_text_is_off_for_empty_no_color(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "")
    assert cli._plain_text() is False


def test_plain_text_follows_term_dumb_only(monkeypatch):
    monkeypatch.setenv("TERM", "dumb")
    assert cli._plain_text() is True
    monkeypatch.setenv("TERM", "xterm-256color")
    assert cli._plain_text() is False


# ------------------------------------------------------------------------ _icon

@pytest.mark.parametrize("symbol", [cli.SHIELD, cli.ALERT, cli.CHECK, cli.LOCK])
def test_icon_keeps_every_symbol_on_a_utf8_terminal(symbol):
    assert cli._icon(symbol, _terminal("utf-8")) == symbol


@pytest.mark.parametrize("symbol", [cli.SHIELD, cli.ALERT, cli.CHECK, cli.LOCK])
def test_icon_uses_ascii_markers_on_a_cp1252_terminal(symbol):
    assert cli._icon(symbol, _terminal("cp1252")) == cli._ASCII_MARKERS[symbol]


def test_icon_uses_ascii_markers_with_no_color_on_a_utf8_terminal(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")
    stream = _terminal("utf-8")
    assert cli._icon(cli.SHIELD, stream) == "[+]"
    assert cli._icon(cli.ALERT, stream) == "[!]"
    assert cli._icon("☃", stream) == ""


def test_icon_uses_ascii_markers_when_not_a_tty():
    stream = SimpleNamespace(encoding="utf-8", isatty=lambda: False)
    assert cli._icon(cli.CHECK, stream) == "[ok]"
    assert cli._lead(cli.CHECK, stream) == "[ok] "
    assert cli._lead("☃", stream) == ""


@pytest.mark.parametrize("error", [OSError, ValueError])
def test_icon_treats_a_failing_isatty_as_not_a_terminal(error):
    def isatty():
        raise error("closed")

    assert cli._icon(cli.ALERT, SimpleNamespace(encoding="utf-8", isatty=isatty)) == "[!]"


def test_icon_defaults_to_stdout():
    with mock.patch.object(sys, "stdout", _terminal("utf-8")):
        assert cli._icon(cli.SHIELD) == cli.SHIELD
    with mock.patch.object(sys, "stdout", _terminal("cp1252")):
        assert cli._icon(cli.SHIELD) == "[+]"
    with mock.patch.object(sys, "stdout", io.StringIO()):
        assert cli._icon(cli.SHIELD) == "[+]"
