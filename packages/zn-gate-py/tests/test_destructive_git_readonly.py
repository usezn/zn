"""Read-only git commands must not be blocked by the destructive-command policy."""

import pytest

from zn_gate import check_command

READ_ONLY_GIT = [
    "git status",
    "git log --oneline -5",
    "git diff",
    "git show HEAD",
    "git branch -a",
    "git remote -v",
    "git blame README.md",
    "git rev-parse HEAD",
    "git ls-files",
    "git tag -l",
]


@pytest.mark.parametrize("cmd", READ_ONLY_GIT)
def test_read_only_git_command_is_not_blocked(cmd):
    res = check_command(cmd)
    assert res.allowed, cmd
    assert res.rule == "none"
