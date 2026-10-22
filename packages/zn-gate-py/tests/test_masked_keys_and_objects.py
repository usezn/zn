"""Masking keeps every value of a dict whose keys hold secrets, and the LlamaIndex
response masking walks objects too (fake secrets only)."""
import dataclasses

import pytest

from zn_gate import GuardBlockError
from zn_gate.integrations.llamaindex import ZnLlamaGuard
from zn_gate.rules import sanitize_tool_result

KEY_A = "AKIA" + "IOSFODNN7EXAMPLE"
KEY_B = "AKIA" + "ZZZZZZZZ7EXAMPLE"


def test_two_keys_with_different_secrets_keep_both_values():
    clean, found = sanitize_tool_result({KEY_A: "first", KEY_B: "second"})
    assert len(clean) == 2
    assert sorted(clean.values()) == ["first", "second"]
    assert KEY_A not in repr(clean) and KEY_B not in repr(clean)
    assert len(found) == 2


def test_a_masked_key_never_replaces_a_clean_key_with_the_same_text():
    masked_key = next(iter(sanitize_tool_result({KEY_A: 1})[0]))
    clean, _ = sanitize_tool_result({masked_key: "clean", KEY_A: "secret"})
    assert clean[masked_key] == "clean"
    assert sorted(map(str, clean.values())) == ["clean", "secret"]


def test_nested_dicts_are_numbered_too():
    clean, _ = sanitize_tool_result({"outer": {KEY_A: 1, KEY_B: 2}})
    assert sorted(clean["outer"].values()) == [1, 2]


def test_keys_without_secrets_are_unchanged():
    data = {"a": 1, "b": {"c": 2}}
    assert sanitize_tool_result(data)[0] == data


@dataclasses.dataclass
class Answer:
    text: str


def test_llamaindex_masks_a_secret_inside_an_object():
    out = ZnLlamaGuard().sanitize_response([Answer("key " + KEY_A)])
    assert KEY_A not in repr(out)


def test_llamaindex_unmaskable_response_is_blocked(monkeypatch):
    import zn_gate.integrations.llamaindex as li
    from zn_gate.rules import Assessment

    block = Assessment(verdict="block", confidence=1.0, rule="secret:unmaskable", reason="x")
    monkeypatch.setattr(li, "_mask_value", lambda value: (value, block))
    with pytest.raises(GuardBlockError):
        ZnLlamaGuard().sanitize_response({"a": "b"})
    assert ZnLlamaGuard(on_block="return").sanitize_response({"a": "b"}).startswith("zn-gate blocked")
