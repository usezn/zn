"""Direct tests for the rc path and world-writable mode helpers."""

import os

import pytest

from zn_gate.destructive import _is_rc_path, _world_writable

RC_NAMES = [".bashrc", ".bash_profile", ".profile", ".zshrc", ".zshenv"]


@pytest.mark.parametrize("name", RC_NAMES)
def test_startup_file_in_a_home_folder_is_an_rc_path(tmp_path, name):
    home = tmp_path / "alice"
    home.mkdir()
    assert _is_rc_path(str(home / name))
    assert _is_rc_path("~/" + name)
    assert _is_rc_path("$HOME/" + name)
    assert _is_rc_path("${HOME}/" + name)


@pytest.mark.parametrize("name", RC_NAMES)
def test_startup_file_in_a_folder_named_like_home_is_an_rc_path(tmp_path, name):
    for folder in ("HOME", "home"):
        d = tmp_path / folder
        d.mkdir(exist_ok=True)
        assert _is_rc_path(str(d / name))


def test_other_files_are_not_rc_paths(tmp_path):
    assert not _is_rc_path(str(tmp_path / "home" / "notes.txt"))
    assert not _is_rc_path(str(tmp_path / "home" / "bashrc"))
    assert not _is_rc_path(str(tmp_path / ".bashrc" / "file"))


@pytest.mark.parametrize("mode,expected", [(0o777, True), (0o775, False), (0o755, False)])
def test_world_writable_for_modes_of_a_temporary_file(tmp_path, mode, expected):
    f = tmp_path / "example.sh"
    f.write_text("echo hi\n")
    os.chmod(f, mode)
    text = format(os.stat(f).st_mode & 0o777, "o")
    assert text == format(mode, "o")
    assert _world_writable(text) is expected
    assert _world_writable("0" + text) is expected
