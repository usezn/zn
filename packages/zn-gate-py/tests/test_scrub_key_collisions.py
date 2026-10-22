"""Masked dict keys and set members that end up equal keep every entry. Fake values only."""
from zn_gate import sanitize_tool_result

A = "AKIA" + "IOSFODNN7EXAMPLE"
B = "AKIA" + "IOSFODNN7EXAMPLF"
C = "sk-test-FAKE" + "0123456789abcdefghijkl"


def test_dict_with_two_secret_keys_keeps_both_values():
    out, det = sanitize_tool_result({A: "first", B: "second", "plain": "x"})
    assert len(out) == 3
    assert sorted(out.values()) == ["first", "second", "x"]
    assert A not in str(out) and B not in str(out)
    assert out["plain"] == "x"


def test_masked_key_next_to_clean_key_with_same_text():
    masked = next(k for k in sanitize_tool_result({A: 1})[0])
    out, _ = sanitize_tool_result({masked: "clean", A: "secret"})
    assert out[masked] == "clean"
    assert sorted(out.values()) == ["clean", "secret"]


def test_nested_dicts_and_lists():
    out, _ = sanitize_tool_result({"o": {A: 1, B: 2}, "l": [{A: 3, B: 4}]})
    assert sorted(out["o"].values()) == [1, 2]
    assert sorted(out["l"][0].values()) == [3, 4]


def test_set_with_two_secrets_keeps_two_elements():
    out, _ = sanitize_tool_result({A, B, "plain"})
    assert isinstance(out, set) and len(out) == 3 and "plain" in out
    assert all(A not in e and B not in e for e in out)
    out, _ = sanitize_tool_result(frozenset({A, B, C}))
    assert isinstance(out, frozenset) and len(out) == 3


def test_no_secret_unchanged():
    d = {"a": 1, "b": [1, 2], 3: "x"}
    assert sanitize_tool_result(d)[0] == d
    assert sanitize_tool_result({"x", "y"})[0] == {"x", "y"}


def test_masked_tuple_members_that_collide_stay_distinct():
    out, _ = sanitize_tool_result({(A, 1), (B, 1), ("plain", 1)})
    assert isinstance(out, set) and len(out) == 3 and ("plain", 1) in out
    assert all(A not in str(e) and B not in str(e) for e in out)
    out, _ = sanitize_tool_result(frozenset({(A,), (B,), (C,)}))
    assert isinstance(out, frozenset) and len(out) == 3
