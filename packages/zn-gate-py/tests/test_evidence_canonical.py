"""Fixed expected strings for the canonical record serializers used for hashing."""
from zn_gate.evidence import _canonical, _canonical_ascii


def test_key_order_is_insertion_order_not_sorted():
    assert _canonical({"b": 1, "a": 2}) == '{"b":1,"a":2}'
    assert _canonical_ascii({"b": 1, "a": 2}) == '{"b":1,"a":2}'


def test_nested_objects_and_arrays_are_compact():
    record = {"z": {"y": [1, {"x": None}], "a": {}}, "e": []}
    expected = '{"z":{"y":[1,{"x":null}],"a":{}},"e":[]}'
    assert _canonical(record) == expected
    assert _canonical_ascii(record) == expected


def test_booleans_and_null():
    record = {"t": True, "f": False, "n": None}
    expected = '{"t":true,"f":false,"n":null}'
    assert _canonical(record) == expected
    assert _canonical_ascii(record) == expected


def test_floats_as_python_writes_them():
    record = {"a": 1.0, "b": 1e21, "c": 1.5, "d": 0.0, "e": 100}
    expected = '{"a":1.0,"b":1e+21,"c":1.5,"d":0.0,"e":100}'
    assert _canonical(record) == expected
    assert _canonical_ascii(record) == expected


def test_unicode_kept_in_canonical_and_escaped_in_ascii():
    record = {"ké": "café ☃ \U0001F600"}
    assert _canonical(record) == '{"ké":"café ☃ \U0001F600"}'
    assert _canonical_ascii(record) == '{"k\\u00e9":"caf\\u00e9 \\u2603 \\ud83d\\ude00"}'


def test_control_and_quote_characters_are_escaped_in_both_forms():
    record = {"a": 'q"\\\n\t\x01'}
    expected = '{"a":"q\\"\\\\\\n\\t\\u0001"}'
    assert _canonical(record) == expected
    assert _canonical_ascii(record) == expected


def test_lone_surrogate_differs_only_in_form():
    assert _canonical_ascii({"a": "x\ud800y"}) == '{"a":"x\\ud800y"}'
