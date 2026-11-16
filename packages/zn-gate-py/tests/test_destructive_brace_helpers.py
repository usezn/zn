"""The brace helpers on their own, with made-up words (current behaviour)."""
from zn_gate.destructive import _brace_alts, _expand_braces


def test_list_expands_in_order():
    assert _expand_braces("pre{one,two,three}post") == ["preonepost", "pretwopost", "prethreepost"]


def test_empty_alternative_is_kept():
    assert _expand_braces("fo{o,}") == ["foo", "fo"]


def test_two_lists_multiply():
    assert _expand_braces("{a,b}{c,d}") == ["ac", "ad", "bc", "bd"]


def test_nested_braces_expand_inner_list_first():
    assert _expand_braces("x{a,b{c,d}}") == ["xa", "xbc", "xbd"]


def test_nested_braces_with_a_suffix():
    assert _expand_braces("x{a,b{c,d}}y") == ["xay", "xbcy", "xbdy"]


def test_deeper_nesting_has_no_duplicates():
    assert _expand_braces("{a,b{c,d{e,f}}}") == ["a", "bc", "bde", "bdf"]


def test_word_without_braces_is_returned_as_is():
    assert _expand_braces("plain") == ["plain"]
    assert _brace_alts("plain") == ["plain"]


def test_single_item_braces_are_not_a_list():
    assert _expand_braces("a{b}c") == ["a{b}c"]


def test_unmatched_braces_stay_literal():
    assert _expand_braces("a{b,c") == ["a{b,c"]
    assert _expand_braces("a}b{") == ["a}b{"]
    assert _brace_alts("tail,{x,y") == ["tail,{x,y"]


def test_numeric_sequence_up_and_down():
    assert _brace_alts("f{1..4}") == ["f1", "f2", "f3", "f4"]
    assert _brace_alts("f{3..1}") == ["f3", "f2", "f1"]


def test_letter_sequence():
    assert _brace_alts("{a..c}") == ["a", "b", "c"]


def test_sequence_with_equal_ends_is_one_word():
    assert _brace_alts("v{2..2}") == ["v2"]
    assert _brace_alts("{q..q}") == ["q"]


def test_sequences_left_alone():
    assert _brace_alts("{a..C}") == ["{a..C}"]  # mixed case
    assert _brace_alts("{1..100}") == ["{1..100}"]  # more than two digits


def test_sequence_inside_a_list():
    assert _brace_alts("{x,y}{1..2}") == ["x1", "x2", "y1", "y2"]


def test_exactly_64_results_are_returned():
    out = _expand_braces("w{" + "," * 63 + "}")
    # 64 alternatives are within the limit; they are all the same word, so one is kept
    assert out == ["w"]


def test_more_than_64_results_give_none():
    assert _expand_braces("w{" + "," * 64 + "}") is None
    assert _brace_alts("w{" + "," * 64 + "}") is None


def test_product_over_the_limit_gives_none():
    assert _brace_alts("{a,b}" * 7) is None
    assert len(_brace_alts("{a,b}" * 6)) == 64


def test_custom_limit():
    assert len(_expand_braces("{a,b}{c,d}", limit=4)) == 4
    assert _expand_braces("{a,b}{c,d}", limit=3) is None


def test_repeated_words_expand_once_and_count_towards_the_limit():
    assert _expand_braces("{a,a}") == ["a"]
    assert _expand_braces("{a,a}", limit=1) is None
    assert _expand_braces("x{a,b{a,c}}") == ["xa", "xba", "xbc"]
    assert _expand_braces("x{a,b{a,c}}", limit=3) is None
    assert _expand_braces("x{a,b{a,c}}", limit=4) == ["xa", "xba", "xbc"]
