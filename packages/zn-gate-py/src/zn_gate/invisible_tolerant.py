"""Invisible-tolerant variants of the prompt-injection phrase rules.

The stripped view ("ignoreall...") and the spaced view ("ig nore all...") each read one use of the invisible
characters. A text that uses one as a space AND another inside a word ("ig<U+200B>nore<U+200B>all ...") fits
neither. The variant built here accepts any invisible character after every element of the pattern, and in place
of every whitespace element, so it matches that text on the original string. It is the same transformer as
packages/zn-gate/lib/invisible_tolerant.js and src/prompt_guard/tolerant.rs.

A small tokenizer walks the pattern source: it knows escapes, character classes, groups, lookarounds and
quantifiers, and never inserts inside a class or inside a negative lookahead or a lookbehind (a positive
lookahead is read like any group).
"""
from __future__ import annotations

import re
from typing import List, Tuple

# The same table as ZERO_WIDTH_RE and INVISIBLE_ASTRAL_RE in rules.py (and lib/invisible.js); a test compares it
# with test/fixtures/invisible_chars.json.
INVISIBLE_RANGES: Tuple[Tuple[int, int], ...] = (
    (0x00AD, 0x00AD), (0x061C, 0x061C), (0x115F, 0x1160), (0x180E, 0x180E), (0x200B, 0x200F), (0x2060, 0x2060),
    (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xE0000, 0xE007F), (0xE0100, 0xE01EF),
)

_BS = chr(92)
INVISIBLE_CLASS = ''.join(
    _BS + 'U%08X' % lo if lo == hi else _BS + 'U%08X-' % lo + _BS + 'U%08X' % hi for lo, hi in INVISIBLE_RANGES
)
_INVISIBLE = '[' + INVISIBLE_CLASS + ']'
_HAS_INVISIBLE_RE = re.compile(_INVISIBLE)
_INVISIBLE_RUN_RE = re.compile(_INVISIBLE + '+')


def has_invisible(text: str) -> bool:
    return _HAS_INVISIBLE_RE.search(text) is not None


def collapse_invisible_runs(text: str) -> str:
    """Every run of invisible characters becomes one character, so the optional gaps of a tolerant pattern never
    face a long run (the work stays linear however long the run is)."""
    return _INVISIBLE_RUN_RE.sub(chr(0x200B), text)


def tolerant_source(source: str) -> str:
    inv = _INVISIBLE
    gap = inv + '*'
    c = list(source)
    n = len(c)
    digits = '0123456789'

    def escape_end(i: int) -> int:
        k = c[i + 1] if i + 1 < n else None
        if k is None:
            return i + 1
        if k == 'x':
            return min(n, i + 4)
        if k == 'u':
            return min(n, i + 6)
        if k == 'U':
            return min(n, i + 10)
        if k == 'N' and i + 2 < n and c[i + 2] == '{':
            e = source.find('}', i + 3)
            return n if e < 0 else e + 1
        if k in digits:
            j = i + 2
            while j < n and c[j] in digits:
                j += 1
            return j
        return i + 2

    def class_info(i: int) -> Tuple[int, bool, bool]:
        j = i + 1
        negated = False
        if j < n and c[j] == '^':
            negated = True
            j += 1
        ws = False
        if j < n and c[j] == ']':  # a "]" first in the class is a literal
            j += 1
        while j < n and c[j] != ']':
            if c[j] == _BS:
                if j + 1 < n and c[j + 1] == 's':
                    ws = True
                j = escape_end(j)
            else:
                if c[j] == ' ':
                    ws = True
                j += 1
        return min(n, j + 1), negated, ws

    def group_end(i: int) -> int:
        depth = 0
        j = i
        while j < n:
            if c[j] == _BS:
                j = escape_end(j)
                continue
            if c[j] == '[':
                j = class_info(j)[0]
                continue
            if c[j] == '(':
                depth += 1
            elif c[j] == ')':
                depth -= 1
                if depth == 0:
                    return j + 1
            j += 1
        return n

    def quant_end(i: int) -> int:
        j = i
        if j < n and c[j] in '?*+':
            j += 1
        elif j < n and c[j] == '{':
            k = j + 1
            seen = 0
            while k < n and c[k] in digits:
                k += 1
                seen += 1
            if k < n and c[k] == ',':
                k += 1
                while k < n and c[k] in digits:
                    k += 1
                    seen += 1
            if k < n and c[k] == '}' and seen > 0:
                j = k + 1
            else:
                return i
        else:
            return i
        if j < n and c[j] in '?+':
            j += 1
        return j

    def ws_atom(tok: str, quant: str) -> str:
        return '(?:' + tok + '|' + inv + ')' + quant + gap

    def part(a: int, b: int) -> str:
        return ''.join(c[a:b])

    flags_only = re.compile(r'^\(\?[a-zA-Z-]+\)')
    out: List[str] = []
    i = 0
    # One entry per open group: True for a positive lookahead, whose closing parenthesis gets no gap (it is
    # zero-width), but whose content is tolerant like the rest.
    open_groups: List[bool] = []
    while i < n:
        ch = c[i]
        if ch == _BS:
            e = escape_end(i)
            tok = part(i, e)
            if tok in (_BS + 'b', _BS + 'B', _BS + 'A', _BS + 'Z'):
                out.append(tok)
                i = e
                continue
            q = quant_end(e)
            quant = part(e, q)
            out.append(ws_atom(tok, quant) if tok in (_BS + 's', _BS + ' ') else tok + quant + gap)
            i = q
            continue
        if ch == '[':
            end, negated, ws = class_info(i)
            tok = part(i, end)
            q = quant_end(end)
            quant = part(end, q)
            out.append(ws_atom(tok, quant) if ws and not negated else tok + quant + gap)
            i = q
            continue
        if ch == '(':
            if i + 2 < n and c[i + 1] == '?' and c[i + 2] == '(':
                raise ValueError('conditional groups are not supported')
            if c[i + 1:i + 3] == ['?', '=']:
                out.append('(?=')
                open_groups.append(True)
                i += 3
                continue
            look = c[i + 1:i + 3] == ['?', '!'] or c[i + 1:i + 4] in (['?', '<', '='], ['?', '<', '!'])
            if look:
                e = group_end(i)
                q = quant_end(e)
                out.append(part(i, q))
                i = q
                continue
            if c[i + 1:i + 3] == ['?', '#']:
                e = source.find(')', i)
                end = n if e < 0 else e + 1
                out.append(part(i, end))
                i = end
                continue
            if c[i + 1:i + 4] == ['?', 'P', '=']:
                # A named back-reference is one element.
                e = group_end(i)
                q = quant_end(e)
                out.append(part(i, e) + part(e, q) + gap)
                i = q
                continue
            m = flags_only.match(part(i, min(n, i + 12)))
            if m:
                out.append(m.group(0))
                i += len(m.group(0))
                continue
            j = i + 1
            if j < n and c[j] == '?':
                j += 1
                if c[j] in ':>':
                    j += 1
                elif c[j] == 'P':
                    e = source.find('>', j)
                    j = n if e < 0 else e + 1
                else:
                    while j < n and c[j] != ':':
                        j += 1
                    j += 1
            out.append(part(i, j))
            open_groups.append(False)
            i = j
            continue
        if ch == ')':
            q = quant_end(i + 1)
            out.append(')' + part(i + 1, q) + ('' if open_groups and open_groups.pop() else gap))
            i = q
            continue
        if ch in '|^$':
            out.append(ch)
            i += 1
            continue
        if ch == '.':
            q = quant_end(i + 1)
            out.append('.' + part(i + 1, q) + gap)
            i = q
            continue
        if ch in '?*+':
            out.append(ch)
            i += 1
            continue
        q = quant_end(i + 1)
        quant = part(i + 1, q)
        out.append(ws_atom(' ', quant) if ch == ' ' else ch + quant + gap)
        i = q
    return ''.join(out)


def tolerant_regex(pat: 're.Pattern[str]') -> 're.Pattern[str]':
    """The tolerant variant of a compiled pattern, with the same flags."""
    return re.compile(tolerant_source(pat.pattern), pat.flags)
