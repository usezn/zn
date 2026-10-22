"""CLI display helpers: _home_display shows a path under the home directory as ~/...,
_plain_text reads NO_COLOR and TERM, and _lead puts a symbol and a space in front of a line
only when the stream can show it."""
import os
from pathlib import Path

import pytest

from zn_gate.cli import ALERT, CHECK, LOCK, SHIELD, _home_display, _lead, _plain_text

_ENV_KEYS = ("NO_COLOR", "TERM")


@pytest.fixture
def clean_env(monkeypatch):
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


class _Stream:
    """A minimal text stream: only the encoding matters to _lead."""

    def __init__(self, encoding):
        self.encoding = encoding


# _home_display: paths under the home directory

def test_path_inside_home_is_shown_with_tilde(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert _home_display(tmp_path / ".zn" / "evidence.jsonl") == "~/.zn/evidence.jsonl"


def test_nested_path_inside_home_uses_forward_slashes(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert _home_display(tmp_path / "projects" / "app" / "mcp.json") == "~/projects/app/mcp.json"


def test_path_outside_home_is_unchanged(monkeypatch, tmp_path):
    home = tmp_path / "home" / "dev"
    home.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    outside = tmp_path / "srv" / "data.json"
    assert _home_display(outside) == str(outside)


def test_sibling_directory_sharing_the_home_name_prefix_is_not_shortened(monkeypatch, tmp_path):
    # /home/dev2/x must not be read as inside /home/dev.
    home = tmp_path / "dev"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    sibling = tmp_path / "dev2" / "x.txt"
    assert _home_display(sibling) == str(sibling)


def test_home_unset_falls_back_to_the_account_home(monkeypatch):
    # Without HOME, Path.home() asks the account database. A path below that directory
    # is still shown with ~/.
    monkeypatch.delenv("HOME", raising=False)
    account_home = Path(os.path.expanduser("~"))
    assert _home_display(account_home / "notes.txt") == "~/notes.txt"


@pytest.mark.skipif(os.name != "nt", reason="Windows home (USERPROFILE) only applies on Windows")
def test_windows_userprofile_is_used_as_home(monkeypatch, tmp_path):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    assert _home_display(tmp_path / "AppData" / "x.json") == "~/AppData/x.json"


def test_home_directory_itself_is_shown_as_tilde(monkeypatch, tmp_path):
    # Same as the Node.js package: the home folder itself is "~/".
    monkeypatch.setenv("HOME", str(tmp_path))
    assert _home_display(tmp_path) == "~/"


# _plain_text: NO_COLOR and TERM=dumb

def test_plain_text_off_by_default(clean_env):
    assert _plain_text() is False


@pytest.mark.parametrize("value", ["1", "yes", "0", " "])
def test_any_non_empty_no_color_means_plain(clean_env, value):
    # no-color.org: the variable counts when it is set to any non-empty value.
    clean_env.setenv("NO_COLOR", value)
    assert _plain_text() is True


def test_empty_no_color_does_not_mean_plain(clean_env):
    clean_env.setenv("NO_COLOR", "")
    assert _plain_text() is False


def test_term_dumb_means_plain(clean_env):
    clean_env.setenv("TERM", "dumb")
    assert _plain_text() is True


@pytest.mark.parametrize("term", ["xterm-256color", "DUMB", ""])
def test_other_terms_do_not_mean_plain(clean_env, term):
    clean_env.setenv("TERM", term)
    assert _plain_text() is False


# _lead: symbol and one space, or nothing

def test_lead_shows_symbol_and_space_on_a_unicode_stream(clean_env):
    assert _lead(SHIELD, _Stream("utf-8")) == f"{SHIELD} "


def test_lead_is_empty_in_plain_text_even_on_a_unicode_stream(clean_env):
    clean_env.setenv("NO_COLOR", "1")
    assert _lead(CHECK, _Stream("utf-8")) == ""


def test_lead_uses_ascii_marker_on_a_stream_that_cannot_encode_the_symbol(clean_env):
    assert _lead(ALERT, _Stream("ascii")) == "[!] "
    assert _lead(CHECK, _Stream("ascii")) == "[ok] "
    assert _lead(LOCK, _Stream("ascii")) == "[ok] "


def test_lead_is_empty_for_a_symbol_with_no_ascii_marker(clean_env):
    assert _lead("☃", _Stream("ascii")) == ""


def test_lead_of_empty_symbol_is_empty(clean_env):
    assert _lead("", _Stream("utf-8")) == ""


def test_lead_treats_a_stream_without_encoding_as_utf8(clean_env):
    assert _lead(SHIELD, _Stream(None)) == f"{SHIELD} "
