"""The shortcuts that make reach --history faster must give what the plain regex passes give."""
import random

from zn_gate import rules as R

_FRAGS = [
    "abcdefghijk", "AB12", " ", "\t", "\r", "\n", "\n", "=", ":", "_", "-", "key", "é", "  ", "x" * 10,
    "password", "TOKEN", "api_key", "apikey", "Access-Key", "client_secret", "auth_token", "=>", ":=", "'", '"', "abc def ghi",
]


def _texts(seed, count, pad=0):
    rnd = random.Random(seed)
    for _ in range(count):
        yield "".join(rnd.choice(_FRAGS) for _ in range(rnd.randint(1, 60))) + "x" * pad


def test_wrap_break_spans_equal_the_regex_finditer():
    for text in _texts(1, 4000):
        assert R._wrap_break_spans(text) == [m.span() for m in R.WRAP_BREAK_RE.finditer(text)], repr(text)


def test_invisible_view_is_the_same_when_asked_twice():
    text = "abcdefghij\nklmnopqrst and a​hidden one"
    first = R.invisible_view(text)
    assert first is not None
    assert R.invisible_view(text) is first
    assert R.invisible_view("plain text") is None


def test_quoted_key_search_equals_the_plain_search():
    for text in _texts(2, 1500, pad=600):
        starts = R._kv_open_candidates(text)
        pos_plain = pos_fast = 0
        while True:
            a = R._KV_OPEN_RE.search(text, pos_plain)
            b = R._kv_open_search(text, pos_fast, starts)
            assert (a.span() if a else None) == (b.span() if b else None), repr(text)
            if a is None:
                break
            pos_plain = pos_fast = a.end()


def test_a_long_text_without_a_secret_literal_is_skipped_and_one_with_it_is_not():
    filler = "word " * 200
    assert R.redact_secrets(filler)[1] == []
    key = "AKIAIOSFODNN7EXAMPLE"
    assert [d["rule"] for d in R.redact_secrets(filler + key + " " + filler)[1]] == ["secret:aws_access_key"]
    token = "ghp_" + "aB3dE5fG7h" * 3 + "aB3dE5"
    assert [d["rule"] for d in R.redact_secrets(filler + token + " " + filler)[1]] == ["secret:github_token"]
    aws = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    assert R.redact_secrets(filler + aws + "\n" + filler)[1]
