"""Whether a tool result had a secret masked is decided by scanning it, not by
==, which an object in the result can define to always answer True."""
import uuid

import pytest

from zn_gate import GuardBlockError
from zn_gate.guard import _secret_masked
from zn_gate.integrations import ZnGuardCallbackHandler
from zn_gate.integrations.native import _Policy

FAKE_KEY = "AKIA" + "IOSFODNN7EXAMPLE"


class AlwaysEqual:
    def __init__(self, note):
        self.note = note

    def __eq__(self, other):
        return True

    def __ne__(self, other):
        return False

    __hash__ = object.__hash__


@pytest.mark.parametrize("make", [lambda: AlwaysEqual("key=" + FAKE_KEY), lambda: [AlwaysEqual("key=" + FAKE_KEY)]])
def test_handler_stops_a_secret_in_an_object_equal_to_everything(make):
    with pytest.raises(GuardBlockError) as ctx:
        ZnGuardCallbackHandler().on_tool_end(make(), run_id=uuid.uuid4())
    assert ctx.value.assessment.rule.startswith("secret")
    assert FAKE_KEY not in str(ctx.value)


def test_handler_in_ignore_mode_returns_the_masked_value():
    out = ZnGuardCallbackHandler(on_block="ignore").on_tool_end(AlwaysEqual("key=" + FAKE_KEY), run_id=uuid.uuid4())
    assert FAKE_KEY not in repr(out)


def test_a_clean_object_equal_to_everything_is_left_alone():
    obj = AlwaysEqual("hello")
    assert ZnGuardCallbackHandler().on_tool_end(obj, run_id=uuid.uuid4()) is obj
    assert _secret_masked(obj, {"note": "hello"}) is False


def test_native_policy_reports_the_change():
    policy = _Policy("test", "raise", True, True, False, None)
    blocked, clean, changed = policy.output(AlwaysEqual("key=" + FAKE_KEY))
    assert blocked is None and changed is True
    assert FAKE_KEY not in repr(clean)
    assert policy.output("plain text")[2] is False
