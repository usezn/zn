"""sanitize_tool_result(data) masks secrets in bytes and in objects, in a copy
(fake secrets only)."""
import dataclasses

import pytest

from zn_gate.integrations.llamaindex import ZnLlamaGuard
from zn_gate.rules import sanitize_tool_result

KEY = "AKIA" + "IOSFODNN7EXAMPLE"


def test_bytes_are_masked():
    clean, found = sanitize_tool_result(b"token " + KEY.encode() + b" end")
    assert isinstance(clean, bytes) and KEY.encode() not in clean
    assert found


def test_bytearray_keeps_its_type_and_the_original_is_untouched():
    original = bytearray(b"k=" + KEY.encode())
    clean, _ = sanitize_tool_result(original)
    assert isinstance(clean, bytearray) and KEY.encode() not in bytes(clean)
    assert KEY.encode() in bytes(original)


def test_bytes_with_other_binary_data_survive():
    raw = b"\xff\xfe" + KEY.encode() + b"\x00"
    clean, _ = sanitize_tool_result(raw)
    assert clean.startswith(b"\xff\xfe") and clean.endswith(b"\x00")
    assert KEY.encode() not in clean


def test_clean_bytes_come_back_as_the_same_object():
    raw = b"nothing here"
    assert sanitize_tool_result(raw)[0] is raw


def test_bytes_inside_a_dict():
    clean, found = sanitize_tool_result({"blob": KEY.encode()})
    assert KEY.encode() not in repr(clean).encode() and found


@dataclasses.dataclass
class Row:
    text: str
    n: int = 1


@dataclasses.dataclass(frozen=True)
class Frozen:
    text: str


def test_dataclass_is_masked_in_a_copy():
    row = Row("key " + KEY)
    clean, found = sanitize_tool_result(row)
    assert isinstance(clean, Row) and KEY not in clean.text and clean.n == 1
    assert row.text == "key " + KEY
    assert found


def test_frozen_dataclass_is_masked_in_a_copy():
    row = Frozen(KEY)
    clean, _ = sanitize_tool_result(row)
    assert isinstance(clean, Frozen) and KEY not in clean.text and row.text == KEY


def test_nested_dataclass_in_a_list():
    clean, _ = sanitize_tool_result([Row(KEY)])
    assert KEY not in repr(clean)


def test_clean_dataclass_is_returned_as_is():
    row = Row("fine")
    assert sanitize_tool_result(row)[0] is row


def test_pydantic_model_is_masked_in_a_copy():
    pydantic = pytest.importorskip("pydantic")

    class Doc(pydantic.BaseModel):
        body: str
        tags: list = []

    doc = Doc(body="x " + KEY, tags=[KEY])
    clean, found = sanitize_tool_result(doc)
    assert isinstance(clean, Doc) and KEY not in repr(clean)
    assert KEY in doc.body and found


class Plain:
    def __init__(self, text):
        self.text = text


class Slotted:
    __slots__ = ("text",)

    def __init__(self, text):
        self.text = text


def test_plain_object_is_masked_in_a_copy():
    obj = Plain(KEY)
    clean, _ = sanitize_tool_result(obj)
    assert isinstance(clean, Plain) and KEY not in clean.text and obj.text == KEY


def test_slotted_object_is_masked_in_a_copy():
    obj = Slotted(KEY)
    clean, _ = sanitize_tool_result(obj)
    assert KEY not in clean.text and obj.text == KEY


def test_object_cycle_does_not_loop():
    a = Plain(KEY)
    a.me = a
    clean, _ = sanitize_tool_result(a)
    assert KEY not in clean.text


class Opaque:
    __slots__ = ()

    def __str__(self):
        return "token " + KEY


def test_object_without_fields_comes_back_as_masked_text():
    clean, found = sanitize_tool_result(Opaque())
    assert isinstance(clean, str) and KEY not in clean and found


def test_object_without_fields_and_no_secret_is_left_alone():
    class Quiet:
        __slots__ = ()
    q = Quiet()
    assert sanitize_tool_result(q)[0] is q


def test_numbers_and_none_pass_through():
    assert sanitize_tool_result([1, 2.5, None, True])[0] == [1, 2.5, None, True]


def test_llamaindex_masks_bytes_and_objects():
    guard = ZnLlamaGuard()
    assert KEY.encode() not in guard.sanitize_response(KEY.encode())
    assert KEY not in repr(guard.sanitize_response(Row(KEY)))
    assert KEY not in repr(guard.sanitize_response(Plain(KEY).__dict__))
