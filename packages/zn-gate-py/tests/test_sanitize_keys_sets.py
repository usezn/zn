"""sanitize_tool_result(data) redacts dict keys and set items, not only values."""
from zn_gate import sanitize_tool_result

KEY = "AKIA" + "IOSFODNN7EXAMPLE"


def test_dict_key_masked():
    out, det = sanitize_tool_result({KEY: "value"})
    assert KEY not in repr(out)
    assert list(out.values()) == ["value"]
    assert det


def test_set_item_masked():
    out, det = sanitize_tool_result({"id " + KEY, "plain"})
    assert isinstance(out, set)
    assert KEY not in repr(out)
    assert "plain" in out
    assert det


def test_frozenset_item_masked():
    out, _ = sanitize_tool_result(frozenset({KEY}))
    assert isinstance(out, frozenset)
    assert KEY not in repr(out)


def test_nested_masked():
    data = {"a": [({KEY: {"k " + KEY}},)], "b": frozenset({("t", KEY)})}
    out, det = sanitize_tool_result(data)
    assert KEY not in repr(out)
    assert isinstance(out["a"], list) and isinstance(out["a"][0], tuple)
    assert len(det) >= 3


def test_key_collision_keeps_both_values():
    a = "k=" + KEY
    b = "k=" + "AKIA" + "IOSFODNN7EXAMPL2"
    out, _ = sanitize_tool_result({a: 1, b: 2})
    assert KEY not in repr(out)
    assert sorted(out.values()) == [1, 2]
    assert len(out) == 2
    assert any(k.endswith("_2") for k in out)
    # deterministic
    out2, _ = sanitize_tool_result({a: 1, b: 2})
    assert out == out2


def test_non_string_keys_and_types_unchanged():
    out, det = sanitize_tool_result({1: "a", None: "b", "n": 5})
    assert out == {1: "a", None: "b", "n": 5}
    assert det == []
