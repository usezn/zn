"""_home_mcp_files lists only existing MCP config files of the user's home."""

import os
import sys

import pytest

from zn_gate import cli


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    monkeypatch.setenv("USERPROFILE", str(h))
    for name in ("CODEX_HOME", "XDG_CONFIG_HOME", "APPDATA"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sys, "platform", "linux")
    return h


def touch(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("")
    return path


def test_nothing_exists_gives_empty_list(home):
    assert cli._home_mcp_files() == []


def test_only_existing_files_are_listed_in_order(home):
    cursor = touch(home / ".cursor" / "mcp.json")
    claude = touch(home / ".claude.json")
    codex = touch(home / ".codex" / "config.toml")
    amazonq = touch(home / ".aws" / "amazonq" / "mcp.json")
    assert cli._home_mcp_files() == [claude, cursor, codex, amazonq]


def test_directory_with_a_candidate_name_is_not_listed(home):
    (home / ".claude.json").mkdir()
    assert cli._home_mcp_files() == []


def test_codex_home_moves_the_codex_config(home, tmp_path, monkeypatch):
    touch(home / ".codex" / "config.toml")
    moved = touch(home / "elsewhere" / "config.toml")
    monkeypatch.setenv("CODEX_HOME", str(home / "elsewhere"))
    assert cli._home_mcp_files() == [moved]


def test_xdg_config_home_moves_opencode_and_linux_claude_desktop(home, monkeypatch):
    touch(home / ".config" / "opencode" / "opencode.json")
    xdg = home / "xdg"
    desktop = touch(xdg / "Claude" / "claude_desktop_config.json")
    oc = touch(xdg / "opencode" / "opencode.jsonc")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    assert cli._home_mcp_files() == [desktop, oc]


def test_darwin_claude_desktop_path(home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    desktop = touch(
        home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    )
    touch(home / ".config" / "Claude" / "claude_desktop_config.json")
    assert cli._home_mcp_files() == [desktop]


def test_win32_claude_desktop_uses_appdata(home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    appdata = home / "Roaming"
    desktop = touch(appdata / "Claude" / "claude_desktop_config.json")
    monkeypatch.setenv("APPDATA", str(appdata))
    assert cli._home_mcp_files() == [desktop]


def test_win32_claude_desktop_default_without_appdata(home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    desktop = touch(home / "AppData" / "Roaming" / "Claude" / "claude_desktop_config.json")
    assert cli._home_mcp_files() == [desktop]


def test_link_pointing_outside_home_is_left_out(home, tmp_path):
    outside = touch(tmp_path / "outside" / "mcp.json")
    link = home / ".cursor" / "mcp.json"
    link.parent.mkdir()
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks cannot be created here")
    inside = touch(home / ".claude.json")
    assert cli._home_mcp_files() == [inside]


def test_link_pointing_inside_home_is_kept(home):
    target = touch(home / "dotfiles" / "claude.json")
    link = home / ".claude.json"
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks cannot be created here")
    assert cli._home_mcp_files() == [link]
