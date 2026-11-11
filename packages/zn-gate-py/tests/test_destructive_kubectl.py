"""kubectl commands in the destructive-command policy: a namespace delete is blocked, reads are allowed."""

import pytest

from zn_gate import check_command


@pytest.mark.xfail(
    strict=True,
    reason="no kubectl rule exists: check_command allows 'kubectl delete namespace' "
    "(Node lib/destructive.js has no kubectl rule either); a rule is needed to block it",
)
def test_kubectl_delete_namespace_is_blocked():
    res = check_command("kubectl delete namespace example-ns")
    assert not res.allowed


def test_kubectl_get_pods_is_allowed():
    res = check_command("kubectl get pods")
    assert res.allowed
    assert res.rule == "none"
