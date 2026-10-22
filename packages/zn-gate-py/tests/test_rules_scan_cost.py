"""The cost of a windowed scan grows linearly with the input.

An input over MAX_SCAN_CHARS is scanned in overlapping windows. The bound here
is relative (time of the whole scan against the time of one window times the
number of windows), so it does not depend on how fast the runner is.
"""
import math
import time

from zn_gate import rules

PHRASES = {
    'cyrillic': 'Привет мир, это обычный русский текст. ',
    'ascii': 'The quick brown fox jumps over the lazy dog. ',
}
WINDOWS_SIZE = 1024 * 1024


def _text(phrase: str, size: int) -> str:
    return (phrase * (size // len(phrase) + 1))[:size]


def _best_of(fn, runs: int = 2) -> float:
    best = float('inf')
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - t0)
    return best


def test_windowed_scan_is_linear():
    for name, phrase in PHRASES.items():
        big = _text(phrase, WINDOWS_SIZE)
        one = _text(phrase, rules.MAX_SCAN_CHARS)
        step = rules.MAX_SCAN_CHARS - rules.SCAN_WINDOW_OVERLAP
        windows = math.ceil((len(big) - rules.SCAN_WINDOW_OVERLAP) / step)
        assert windows > 2
        single = _best_of(lambda: rules._evaluate_uncached(one, False))
        whole = _best_of(lambda: rules.evaluate(big))
        assert rules.evaluate(big).verdict == 'allow', name
        # Linear cost is about 1x; 4x leaves room for noisy runners and still
        # catches a per-window cost that grows with the input (quadratic).
        assert whole <= windows * single * 4 + 0.5, (name, whole, single, windows)


def test_exfil_terms_are_searched_once_per_target(monkeypatch):
    calls = {'n': 0}
    real = rules.EXFIL_VERBS

    class Counting:
        def search(self, text):
            calls['n'] += 1
            return real.search(text)

    monkeypatch.setattr(rules, 'EXFIL_VERBS', Counting())
    assert rules._evaluate_uncached('plain harmless text about nothing', False).verdict == 'allow'
    # One target (normalized == stripped == raw): the advisory pass reuses the result.
    assert calls['n'] == 1
