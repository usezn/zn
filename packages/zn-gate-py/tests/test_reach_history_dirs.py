"""real_dir_below and config_dir of zn_gate.reach_history, on temporary home folders."""
import os

import pytest

from zn_gate.reach_history import AGENTS, config_dir, real_dir_below

CLAUDE = AGENTS[0]
CODEX = AGENTS[1]

needs_symlink = pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks not available")


def link(target, name):
    try:
        os.symlink(str(target), str(name))
    except (OSError, NotImplementedError):
        pytest.skip("cannot create symlinks here")


@pytest.fixture
def home(tmp_path):
    h = tmp_path / "home"
    h.mkdir()
    return str(h)


# real_dir_below

def test_no_parts_returns_the_base(home):
    assert real_dir_below(home, []) == home


def test_nested_real_folders_are_returned_joined(home):
    os.makedirs(os.path.join(home, "a", "b"))
    assert real_dir_below(home, ["a", "b"]) == os.path.join(home, "a", "b")


def test_a_missing_last_level_gives_none(home):
    os.makedirs(os.path.join(home, "a"))
    assert real_dir_below(home, ["a", "b"]) is None


def test_a_missing_middle_level_gives_none(home):
    assert real_dir_below(home, ["a", "b", "c"]) is None


def test_a_file_in_place_of_a_folder_gives_none(home):
    with open(os.path.join(home, "a"), "w") as f:
        f.write("x")
    assert real_dir_below(home, ["a"]) is None


def test_a_file_in_the_middle_of_the_path_gives_none(home):
    with open(os.path.join(home, "a"), "w") as f:
        f.write("x")
    assert real_dir_below(home, ["a", "b"]) is None


@needs_symlink
def test_a_link_to_a_folder_gives_none(home, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    link(outside, os.path.join(home, "a"))
    assert real_dir_below(home, ["a"]) is None


@needs_symlink
def test_a_link_in_the_middle_of_the_path_gives_none(home, tmp_path):
    outside = tmp_path / "elsewhere"
    (outside / "b").mkdir(parents=True)
    link(outside, os.path.join(home, "a"))
    assert real_dir_below(home, ["a", "b"]) is None


@needs_symlink
def test_a_broken_link_gives_none(home, tmp_path):
    link(tmp_path / "does-not-exist", os.path.join(home, "a"))
    assert real_dir_below(home, ["a"]) is None


# config_dir

def test_without_an_environment_value_the_default_below_home_is_used(home):
    assert config_dir(CLAUDE, home, {}) == ([".claude"], None)
    assert config_dir(CODEX, home, {}) == ([".codex"], None)


def test_an_empty_environment_value_falls_back_to_the_default(home):
    assert config_dir(CLAUDE, home, {"CLAUDE_CONFIG_DIR": ""}) == ([".claude"], None)


def test_a_none_environment_falls_back_to_the_default(home):
    assert config_dir(CODEX, home, None) == ([".codex"], None)


def test_the_default_is_a_copy(home):
    parts, _ = config_dir(CLAUDE, home, {})
    parts.append("changed")
    assert CLAUDE["default_dir"] == [".claude"]


def test_only_the_variable_of_the_agent_counts(home):
    env = {"CODEX_HOME": os.path.join(home, "other")}
    assert config_dir(CLAUDE, home, env) == ([".claude"], None)


def test_an_environment_folder_inside_home_gives_its_parts(home):
    env = {"CLAUDE_CONFIG_DIR": os.path.join(home, "cfg", "claude")}
    assert config_dir(CLAUDE, home, env) == (["cfg", "claude"], None)


def test_an_inside_folder_is_normalised(home):
    env = {"CODEX_HOME": os.path.join(home, "cfg", "..", "codex-home") + os.sep}
    assert config_dir(CODEX, home, env) == (["codex-home"], None)


def test_an_environment_folder_outside_home_gives_its_absolute_path(home, tmp_path):
    outside = str(tmp_path / "elsewhere")
    assert config_dir(CLAUDE, home, {"CLAUDE_CONFIG_DIR": outside}) == (None, outside)


def test_a_sibling_with_the_same_prefix_as_home_is_outside(home):
    sibling = home + "-other"
    assert config_dir(CODEX, home, {"CODEX_HOME": sibling}) == (None, sibling)


def test_home_itself_is_treated_as_outside(home):
    assert config_dir(CLAUDE, home, {"CLAUDE_CONFIG_DIR": home}) == (None, home)


def test_a_folder_that_does_not_exist_is_still_returned(home):
    env = {"CLAUDE_CONFIG_DIR": os.path.join(home, "missing")}
    assert config_dir(CLAUDE, home, env) == (["missing"], None)


def test_a_dotdot_path_that_leaves_home_is_outside(home):
    env = {"CODEX_HOME": os.path.join(home, "..", "elsewhere")}
    parts, absolute = config_dir(CODEX, home, env)
    assert parts is None
    assert absolute == os.path.abspath(os.path.join(home, "..", "elsewhere"))


def test_a_relative_environment_path_is_resolved_against_the_working_folder(home, monkeypatch):
    monkeypatch.chdir(home)
    assert config_dir(CLAUDE, home, {"CLAUDE_CONFIG_DIR": "rel"}) == (["rel"], None)


@needs_symlink
def test_a_link_inside_home_is_not_followed_by_the_parts(home, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    link(outside, os.path.join(home, "cfg"))
    parts, absolute = config_dir(CLAUDE, home, {"CLAUDE_CONFIG_DIR": os.path.join(home, "cfg")})
    assert (parts, absolute) == (["cfg"], None)
    assert real_dir_below(home, parts) is None
