"""Tool-call arguments over the 4 MB scan limit are blocked, as in the npm package; a result that large keeps
the truncated flag (block_truncated decides). Fictitious text only."""
from zn_gate.guard import check_tool_call, check_tool_result
from zn_gate.rules import MAX_TOOL_RESULT_SCAN_CHARS

BIG = "a" * (MAX_TOOL_RESULT_SCAN_CHARS + 1)


def test_oversize_argument_is_blocked():
    res = check_tool_call("example_tool", {"text": BIG})
    assert not res.allowed
    assert res.rule == "size:oversize"


def test_argument_at_the_limit_is_scanned_not_blocked_for_size():
    res = check_tool_call("example_tool", {"text": "a" * MAX_TOOL_RESULT_SCAN_CHARS})
    assert res.rule != "size:oversize"


def test_oversize_result_keeps_the_truncated_flag():
    res = check_tool_result(BIG)
    assert res.rule != "size:oversize"
