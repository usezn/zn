"""Run by test_no_assert_in_verdicts.py, with and without python -O. Prints one line per check:
the name of the check and the name of the error it raised, so the two runs can be compared.
Only fake text; nothing is written or run."""
import decimal
import re
import sys

from zn_gate import evidence, rules


class _NoMatch:
    """A stand-in for a compiled regex whose match finds nothing."""

    def match(self, *args, **kwargs):
        return None


def outcome(fn):
    try:
        fn()
    except BaseException as exc:  # the name of the error is the result
        return type(exc).__name__
    return "no error"


def js_number_not_finite():
    class _Odd(decimal.Decimal):
        def as_tuple(self):
            return decimal.DecimalTuple(0, (1,), "n")

    real = decimal.Decimal
    decimal.Decimal = _Odd
    try:
        evidence._js_number(1.5)
    finally:
        decimal.Decimal = real


def backslash_run_missing():
    real = rules._KV_BACKSLASH_RUN_RE
    rules._KV_BACKSLASH_RUN_RE = _NoMatch()
    try:
        rules._find_quoted_credentials('{\\"password\\":\\"correct horse battery\\"}')
    finally:
        rules._KV_BACKSLASH_RUN_RE = real


def word_run_missing():
    real = rules._KV_WORD_RUN_RE
    rules._KV_WORD_RUN_RE = _NoMatch()
    try:
        rules._find_quoted_credentials("password='correct horse battery''x'")
    finally:
        rules._KV_WORD_RUN_RE = real


def value_filter_without_value():
    pattern = re.compile(r"(a)(b)?")
    rules._rule_candidates("probe", pattern, "[R]", "a", None, [100], lambda v, p: False, [])


def main():
    print("debug", __debug__)
    for name, fn in (
        ("js_number_not_finite", js_number_not_finite),
        ("backslash_run_missing", backslash_run_missing),
        ("word_run_missing", word_run_missing),
        ("value_filter_without_value", value_filter_without_value),
    ):
        print(name, outcome(fn))
    # The honest cases still work.
    print("js_number", evidence._js_number(1.5))
    print("kv", rules._find_quoted_credentials('password="correct horse battery"'))
    return 0


if __name__ == "__main__":
    sys.exit(main())
