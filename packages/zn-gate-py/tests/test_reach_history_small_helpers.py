"""Small helpers of zn_gate.reach_history, with fake values only."""
import os

from zn_gate.reach_history import _cut_markers, _inside, _mb

KNOWN = {"AWS_KEY", "URL_PASSWORD"}


def test_a_numbered_marker_of_a_known_type_is_cut_out():
    assert _cut_markers("before __ZN_AWS_KEY_1__ after", KNOWN) == "before   after"


def test_a_redacted_marker_of_a_known_type_is_cut_out():
    assert _cut_markers("a __ZN_REDACTED_URL_PASSWORD__ b", KNOWN) == "a   b"


def test_a_marker_of_an_unknown_type_is_kept():
    text = "x __ZN_OTHER_THING_1__ y"
    assert _cut_markers(text, KNOWN) == text


def test_text_without_a_marker_is_returned_unchanged():
    assert _cut_markers("plain text", KNOWN) == "plain text"


def test_a_path_inside_home_gives_its_parts(tmp_path):
    home = str(tmp_path / "home")
    assert _inside(home, os.path.join(home, "a", "b")) == ["a", "b"]


def test_home_itself_is_not_inside(tmp_path):
    home = str(tmp_path / "home")
    assert _inside(home, home) is None


def test_a_path_outside_home_is_not_inside(tmp_path):
    home = str(tmp_path / "home")
    assert _inside(home, str(tmp_path / "other" / "x")) is None
    assert _inside(home, str(tmp_path)) is None


def test_mb_of_zero_one_and_five_million_bytes():
    assert _mb(0) == "0.0 MB"
    assert _mb(1_000_000) == "1.0 MB"
    assert _mb(5_000_000) == "4.8 MB"
