from zn_gate import sanitize_tool_result

FAKE_KEY = "AKIA" + "IOSFODNN7EXAMPLE"


def test_dict_keys_are_masked():
    clean, found = sanitize_tool_result({FAKE_KEY: 1, 2: "x"})
    assert FAKE_KEY not in repr(clean)
    assert clean[2] == "x"
    assert found


def test_sets_and_frozensets_are_walked():
    clean, found = sanitize_tool_result({"s": {FAKE_KEY, "ok"}, "f": frozenset([FAKE_KEY])})
    assert FAKE_KEY not in repr(clean)
    assert isinstance(clean["s"], set) and isinstance(clean["f"], frozenset)
    assert "ok" in clean["s"]
    assert found


def test_clean_values_are_unchanged():
    data = {"a": [1, "b", ("c",)], "d": {"e": {"f"}}, "g": frozenset(["h"])}
    clean, found = sanitize_tool_result(data)
    assert clean == data and not found
