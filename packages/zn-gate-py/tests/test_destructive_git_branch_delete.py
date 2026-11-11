"""git branch deletion under the destructive-command policy, Python side (parity with lib/destructive.js).

Python cannot know whether a branch is merged, so only the command shapes are tested. Deleting a
feature branch is allowed. Force-deleting the protected main branch is expected to be blocked, but the
policy has no git branch rule (the Node package has none either), so those cases are strict xfail:
they become failures as soon as a rule starts blocking them, which is the cue to drop the marker.
"""

import pytest

from zn_gate import check_command

ALLOWED_FEATURE_DELETES = [
    "git branch -d feature-x",
    "git branch -D feature-x",
]

MAIN_FORCE_DELETES = [
    "git branch -D main",
    "git branch --delete --force main",
]


@pytest.mark.parametrize("cmd", ALLOWED_FEATURE_DELETES)
def test_branch_delete_of_a_feature_branch_is_allowed(cmd):
    res = check_command(cmd)
    assert res.allowed, cmd
    assert res.rule == "none"


@pytest.mark.xfail(
    strict=True,
    reason="open gap: no git branch rule exists in the Python or Node destructive policy, so force-deleting main is allowed",
)
@pytest.mark.parametrize("cmd", MAIN_FORCE_DELETES)
def test_force_delete_of_main_is_blocked(cmd):
    res = check_command(cmd)
    assert not res.allowed, cmd
    assert res.rule.startswith("destructive:"), cmd
