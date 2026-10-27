import pytest

from zn_gate.integrations.langchain import _output_content


class WithContent:
    def __init__(self, content):
        self.content = content


class NoContent:
    pass


@pytest.mark.parametrize(
    "value",
    ["text", b"bytes", {"a": 1}, ["x"], ("x",), None],
)
def test_plain_values_come_back_unchanged(value):
    assert _output_content(value) is value


def test_object_with_content_returns_content():
    assert _output_content(WithContent("hello")) == "hello"


def test_empty_string_content_is_returned_as_is():
    assert _output_content(WithContent("")) == ""


def test_content_none_returns_object():
    obj = WithContent(None)
    assert _output_content(obj) is obj


def test_missing_content_returns_object():
    obj = NoContent()
    assert _output_content(obj) is obj
