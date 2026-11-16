"""Small helpers of reach --history: the rotation advice text and the folder walk that refuses links.

Everything happens inside a temporary folder; no real secrets are used.
"""
import os

import pytest

from zn_gate.reach_history import DELETE_STEP, LABELS, action_for, real_dir_below


def test_action_for_known_type_uses_label():
    name, where = LABELS["AWS_KEY"]
    text = action_for("AWS_KEY")
    assert text == "Rotate this " + name + " " + where + ", " + DELETE_STEP
    assert text.endswith(DELETE_STEP)


def test_action_for_unknown_type_uses_generic_text():
    text = action_for("SOME_NEW_TYPE")
    assert "some new type" in text
    assert text == "Rotate this some new type at the service it belongs to, " + DELETE_STEP
    assert text.endswith(DELETE_STEP)


def test_real_dir_below_returns_nested_folder(tmp_path):
    (tmp_path / "a" / "b").mkdir(parents=True)
    assert real_dir_below(str(tmp_path), ["a", "b"]) == os.path.join(str(tmp_path), "a", "b")


def test_real_dir_below_missing_level_is_none(tmp_path):
    (tmp_path / "a").mkdir()
    assert real_dir_below(str(tmp_path), ["a", "missing"]) is None


def test_real_dir_below_file_instead_of_folder_is_none(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "b").write_text("not a folder\n")
    assert real_dir_below(str(tmp_path), ["a", "b"]) is None


def test_real_dir_below_symlink_level_is_none(tmp_path):
    target = tmp_path / "target"
    (target / "b").mkdir(parents=True)
    try:
        os.symlink(str(target), str(tmp_path / "link"), target_is_directory=True)
    except (OSError, NotImplementedError, AttributeError):
        pytest.skip("symbolic links are not allowed here")
    assert real_dir_below(str(tmp_path), ["link"]) is None
    assert real_dir_below(str(tmp_path), ["link", "b"]) is None


def test_real_dir_below_empty_parts_returns_base(tmp_path):
    assert real_dir_below(str(tmp_path), []) == str(tmp_path)
