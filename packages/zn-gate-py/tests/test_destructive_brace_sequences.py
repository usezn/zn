"""Brace sequences ({1..3}, {a..c}) in a path, as _expand_seq rewrites them today."""
import pytest

from zn_gate.destructive import _SEQ_RE, _expand_seq


def expand(word):
    return _SEQ_RE.sub(_expand_seq, word)


def test_numeric_range_becomes_a_list(tmp_path):
    assert expand(f"{tmp_path}/file{{1..3}}.txt") == f"{tmp_path}/file{{1,2,3}}.txt"


def test_letter_range_becomes_a_list(tmp_path):
    assert expand(f"{tmp_path}/{{a..c}}.log") == f"{tmp_path}/{{a,b,c}}.log"


def test_reversed_numeric_range_counts_down(tmp_path):
    assert expand(f"{tmp_path}/n{{3..1}}") == f"{tmp_path}/n{{3,2,1}}"


def test_reversed_letter_range_counts_down(tmp_path):
    assert expand(f"{tmp_path}/{{c..a}}") == f"{tmp_path}/{{c,b,a}}"


@pytest.mark.parametrize("seq,item", [("{2..2}", "2"), ("{b..b}", "b")])
def test_one_item_range_loses_its_braces(tmp_path, seq, item):
    assert expand(f"{tmp_path}/x{seq}y") == f"{tmp_path}/x{item}y"


@pytest.mark.parametrize("seq", ["{a..C}", "{A..c}", "{Z..a}"])
def test_mixed_case_range_is_left_as_written(tmp_path, seq):
    word = f"{tmp_path}/{seq}"
    assert expand(word) == word


def test_uppercase_range_is_expanded():
    assert expand("{A..C}") == "{A,B,C}"
