"""ReDoS sweep for the Python CLI and scanner.

Every compiled pattern reachable from the module-level names of cli, rules,
guard, client, evidence and stats (directly, or inside the rule tables those
modules export) must finish 50k-character adversarial inputs within LIMIT_MS.
Patterns are collected at run time, so a new pattern is covered without editing
this file. Each pattern is timed with two operations: a full scan that visits
every match (what search, findall and sub do) and fullmatch. OP_OVERRIDES
narrows a pattern to the operation its call sites use. The JavaScript sweep is
test/regex_sweep.test.js in packages/zn-gate.
"""

import re
import time
import types
import unittest

from zn_gate import cli, client, evidence, guard, rules, stats

MODULES = [cli, rules, guard, client, evidence, stats]
SIZE = 50_000
LIMIT_MS = 100
RUNS = 2

# A pattern whose only call site is fullmatch(): the full scan is quadratic on
# it (about 1.5 s at 8k characters) but no caller runs it that way, so only the
# fullmatch operation is timed. rules.py: _pv_placeholder().
OP_OVERRIDES = {
    r'x{3,}|\*{3,}|\.{3,}|-+|_+|<[^>]*>|\$\{?[^}]*\}?|\{\{?[^}]*\}?\}|%\(?[a-z_]*\)?s|:[a-z_]+|\[[^\]]*\]': ('fullmatch',),
}

# Patterns the sweep reports but does not change here: source prefix -> (size in
# characters, ceiling in ms). rules.py pi:act_as is linear (72 ms at 50k ';' on an
# idle host, up to 166 ms under load): its ceiling is set above that, so a
# change that makes it superlinear still fails. Remove the entry when it is faster.
KNOWN_SLOW = {
    r'(?:(?:(?:^|[.!?;:\r\n  ])[ \t]*': (SIZE, 250),
    # rules.py ZH rules: linear with a lazy {0,80} gap (about 98 ms at 50k on an idle host).
    '忽略[^\\n]{0,80}?': (SIZE, 250),
}


def known_slow(source):
    for prefix, limits in KNOWN_SLOW.items():
        if source.startswith(prefix):
            return limits
    return SIZE, LIMIT_MS


def fill(unit, size=SIZE):
    return (unit * (size // len(unit) + 1))[:size]


def class_chars(source):
    chars = []
    for m in re.finditer(r"\[((?:\\.|[^\]\\])*)\]", source):
        inner = m.group(1)
        k = 0
        while k < len(inner) and len(chars) < 16:
            if inner[k] == "\\" or (k + 1 < len(inner) and inner[k + 1] == "-"):
                k += 2
                continue
            if inner[k] != "^":
                chars.append(inner[k])
            k += 1
    return sorted(set(chars))


def literal_words(source):
    words = re.findall(r"[^\\\[\](){}|*+?.^$,=!<>:#&/-]{2,}", source)
    return sorted(set(words))[:8]


UNITS = [" ", "\n", "\t", "\r\n", "a", "A", "0", "-", "_", ".", "/", "\\", '"', "'", "`",
         "(", ")", "[", "]", "{", "}", "<", ">", "$", "*", "+", "?", "|", "&", ";", ",", ":",
         "#", "%", "=", "!", "@", "~", "ab", "a-", "a.", "a/", '\\"', "\"'", "--a ", "é",
         "忽略", "забудь ", "​", "‮", "ignore ", "sk-", "eyJ", "aB3dE5fG7h/",
         "A_TOKEN=", "<a x=", "![", "/*"]


def adversarial_inputs(source):
    out = set()
    for u in UNITS:
        out.add(fill(u))
        out.add(fill(u) + "!")
    for w in literal_words(source):
        out.add(fill(w))
        out.add(fill(w[:-1]) + "#")
        out.add(fill(w + " ") + "#")
        out.add(fill(" " + w) + "!")
        out.add(fill(w + "\n") + "!")
    chars = class_chars(source)
    for c in chars:
        out.add(fill(c) + "!")
    if chars:
        joined = "".join(chars)
        out.add(fill(joined))
        out.add(fill(joined) + "!")
    out.add(fill(source[:24]))
    out.add(fill(source[:24]) + "!")
    out.add(" " * (SIZE - 1) + "!")
    out.add(" " * (SIZE // 2) + "x" * (SIZE // 2) + "!")
    return sorted(out)


def collect_patterns():
    found = {}

    def visit(value, depth=0):
        if depth > 4:
            return
        if isinstance(value, re.Pattern):
            found.setdefault((value.pattern, value.flags), value)
        elif isinstance(value, (list, tuple, set, frozenset)):
            for v in value:
                visit(v, depth + 1)
        elif isinstance(value, dict):
            for v in value.values():
                visit(v, depth + 1)

    for module in MODULES:
        for name, value in vars(module).items():
            if name.startswith("__") or isinstance(value, types.ModuleType):
                continue
            visit(value)
    return found


def scan_all(pattern, text):
    for _m in pattern.finditer(text):
        pass


def whole(pattern, text):
    pattern.fullmatch(text)


OPERATIONS = {"scan": scan_all, "fullmatch": whole}


def time_op(op, pattern, text, runs):
    """Fastest of `runs` runs of one operation (ms)."""
    best = float("inf")
    for _ in range(runs):
        t0 = time.perf_counter()
        op(pattern, text)
        best = min(best, (time.perf_counter() - t0) * 1000)
    return best


class TestRegexSweep(unittest.TestCase):
    def test_collects_the_patterns_of_the_cli_and_the_scanner(self):
        patterns = collect_patterns()
        sources = [p for (p, _f) in patterns]
        self.assertGreater(len(patterns), 100, "too few patterns collected; the walk is wrong")
        self.assertIn("-----BEGIN [A-Z ]*PRIVATE KEY-----", sources)

    def test_every_pattern_stays_under_100_ms_on_50k_adversarial_inputs(self):
        offenders = []
        for (source, flags), pattern in sorted(collect_patterns().items()):
            size, ceiling = known_slow(source)
            ops = [OPERATIONS[name] for name in OP_OVERRIDES.get(source, ("scan", "fullmatch"))]
            worst_ms, worst_text = 0.0, ""
            for text in adversarial_inputs(source):
                text = text[:size]
                for op in ops:
                    ms = time_op(op, pattern, text, runs=1)
                    if ms > LIMIT_MS:
                        ms = time_op(op, pattern, text, runs=RUNS)
                    if ms > worst_ms:
                        worst_ms, worst_text = ms, text[:16]
            if worst_ms > ceiling:
                offenders.append(
                    f"/{source[:80]}/ flags={flags} took {worst_ms:.1f} ms at {size} chars "
                    f"(limit {ceiling}) on {worst_text!r}..."
                )
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
