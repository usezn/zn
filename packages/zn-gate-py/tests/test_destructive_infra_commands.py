"""Infrastructure and git commands through check_command.

The allow cases are pinned. The block cases are strict expected failures: check_command allows these
commands today, and docs/destructive-commands.md lists six rules, none of them for kubectl, terraform or
git push --force. A strict expected failure fails once a rule blocks the command, so the marker must then
be removed.
"""

import pytest

from zn_gate import check_command

GAP = "check_command allows it today: no rule covers kubectl, terraform or git push --force"


@pytest.mark.parametrize("cmd", ["kubectl get pods", "terraform plan", "git push origin feature/x"])
def test_infra_and_git_command_is_allowed(cmd):
    res = check_command(cmd)
    assert res.allowed, cmd
    assert res.rule == "none"


@pytest.mark.xfail(strict=True, reason=GAP)
@pytest.mark.parametrize(
    "cmd",
    [
        "kubectl delete namespace prod",
        "terraform destroy -auto-approve",
        "git push --force origin main",
    ],
)
def test_destructive_infra_command_is_blocked(cmd):
    res = check_command(cmd)
    assert not res.allowed, cmd
