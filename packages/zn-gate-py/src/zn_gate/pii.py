"""Personal data (PII) detection: a port of the PII layer of packages/zn-gate/lib/scrub/patterns.js.

Every type has the same name, the same validation and the same default as in
Node.js: email, phone (E.164), IBAN (mod 97), card (Luhn and network), DNI and
NIE (control letter), SSN, IPv4 (off by default) and, only when an explicit key
sits next to the value, PERSON_NAME, POSTAL_ADDRESS and USERNAME. A bare name,
address or username without its key is never matched. Detection is local: no
network, no vault.

    find_pii(text, pii=None) -> [{"start", "end", "type", "source": "pii"}]
    redact_pii(text, pii=None) -> (text with __ZN_REDACTED_<TYPE>__ markers, spans)

`pii` is None (the defaults), False (detect nothing) or a dict of booleans
{email, phone, iban, card, dni, ssn, ipv4, name, address, username} that
overrides the defaults. Offsets are indexes into the Python string. The
Node.js and Python results are compared on the same inputs by
tests/test_pii_parity.py; change both sides together and keep
PII_RULES_VERSION equal to SCRUB_RULES_VERSION in patterns.js.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import unquote

from .rules import invisible_view

PII_RULES_VERSION = "2026-10-23.3"

# JavaScript \s and String#trim cover these characters.
_WS = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WS_CLASS = "[" + _WS.replace("\v", "\\v").replace("\f", "\\f") + "]"
_A = re.ASCII

Span = Dict[str, Any]


def _re(src: str, flags: int = 0) -> "re.Pattern[str]":
    # re.ASCII: \d and the case folding of re.I stay ASCII-only, as in JavaScript.
    return re.compile(src, flags | re.ASCII)


# ---------------------------------------------------------------------------
# Checksums and validators
# ---------------------------------------------------------------------------

def luhn_valid(number: str) -> bool:
    total = 0
    dbl = False
    for ch in reversed(number):
        d = ord(ch) - 48
        if d < 0 or d > 9:
            return False
        if dbl:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        dbl = not dbl
    return total % 10 == 0


def _mod97(value: str) -> int:
    rem = 0
    for ch in value:
        code = ord(ch)
        if 65 <= code <= 90:
            rem = (rem * 100 + code - 55) % 97
        else:
            rem = (rem * 10 + code - 48) % 97
    return rem


IBAN_LENGTHS = {
    "AD": 24, "AE": 23, "AL": 28, "AT": 20, "AZ": 28, "BA": 20, "BE": 16, "BG": 22, "BH": 22, "BR": 29,
    "CH": 21, "CR": 22, "CY": 28, "CZ": 24, "DE": 22, "DK": 18, "DO": 28, "EE": 20, "EG": 29, "ES": 24,
    "FI": 18, "FO": 18, "FR": 27, "GB": 22, "GE": 22, "GI": 23, "GL": 18, "GR": 27, "GT": 28, "HR": 21,
    "HU": 28, "IE": 22, "IL": 23, "IS": 26, "IT": 27, "JO": 30, "KW": 30, "KZ": 20, "LB": 28, "LI": 21,
    "LT": 20, "LU": 20, "LV": 21, "MC": 27, "MD": 24, "ME": 22, "MK": 19, "MR": 27, "MT": 31, "MU": 30,
    "NL": 18, "NO": 15, "PK": 24, "PL": 28, "PS": 29, "PT": 25, "QA": 29, "RO": 24, "RS": 22, "SA": 24,
    "SE": 24, "SI": 19, "SK": 24, "SM": 27, "TN": 24, "TR": 26, "UA": 29, "VG": 24, "XK": 20,
}

_IBAN_SEP = _re(r"[\s-]+")
_IBAN_SHAPE = _re(r"^[A-Z]{2}\d{2}[A-Z0-9]+\Z")


def _js_upper(s: str) -> str:
    # JavaScript toUpperCase and Python upper() differ outside ASCII (the sharp s
    # becomes SS in both, but a few ligatures differ); validators only accept
    # ASCII afterwards, so a non-ASCII text is rejected the same way.
    return s.upper()


def iban_valid(raw: str) -> bool:
    iban = _js_upper(_IBAN_SEP.sub("", str(raw)))
    length = IBAN_LENGTHS.get(iban[:2])
    if not length or len(iban) != length:
        return False
    if not _IBAN_SHAPE.match(iban):
        return False
    return _mod97(iban[4:] + iban[:4]) == 1


_DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE"
_DNI_RE = _re(r"^(\d{8})([A-Z])\Z")
_NIE_RE = _re(r"^([XYZ])(\d{7})([A-Z])\Z")


def dni_valid(raw: str) -> bool:
    m = _DNI_RE.match(_js_upper(str(raw).replace("-", "")))
    if not m:
        return False
    return _DNI_LETTERS[int(m.group(1)) % 23] == m.group(2)


def nie_valid(raw: str) -> bool:
    m = _NIE_RE.match(_js_upper(str(raw).replace("-", "")))
    if not m:
        return False
    n = "XYZ".index(m.group(1)) * 10000000 + int(m.group(2))
    return _DNI_LETTERS[n % 23] == m.group(3)


_SSN_RE = _re(r"^(\d{3})-(\d{2})-(\d{4})\Z")


def ssn_valid(raw: str) -> bool:
    m = _SSN_RE.match(raw)
    if not m:
        return False
    area = int(m.group(1))
    if area == 0 or area == 666 or area >= 900:
        return False
    if m.group(2) == "00" or m.group(3) == "0000":
        return False
    return True


def _card_network_ok(d: str) -> bool:
    n = len(d)
    p2, p3, p4, p6 = int(d[:2]), int(d[:3]), int(d[:4]), int(d[:6])
    if d[0] == "4":
        return n in (13, 16, 19)
    if 51 <= p2 <= 55 or 222100 <= p6 <= 272099:
        return n == 16
    if p2 in (34, 37):
        return n == 15
    if p4 == 6011 or p2 == 65 or 644 <= p3 <= 649:
        return 16 <= n <= 19
    if 3528 <= p4 <= 3589:
        return 16 <= n <= 19
    if p2 in (36, 38, 39) or 300 <= p3 <= 305:
        return 14 <= n <= 19
    if p2 == 62:
        return 16 <= n <= 19
    return False


_CARD_SEP = _re(r"[\s-]")
_CARD_DIGITS = _re(r"^\d{13,19}\Z")
_ALL_SAME = _re(r"^(\d)\1+\Z")


def card_valid(raw: str) -> bool:
    d = _CARD_SEP.sub("", str(raw))
    if not _CARD_DIGITS.match(d):
        return False
    if _ALL_SAME.match(d):
        return False
    return _card_network_ok(d) and luhn_valid(d)


_E164_LENGTHS = {
    "44": [10], "34": [9], "33": [9], "49": [7, 8, 9, 10, 11], "39": [9, 10], "351": [9], "31": [9],
    "32": [8, 9], "41": [9], "43": [7, 8, 9, 10, 11, 12, 13], "52": [10], "55": [10, 11], "61": [9],
    "81": [9, 10], "91": [10],
}
_E164_RE = _re(r"^\+(\d{8,15})\Z")
_E164_SEQ = _re(r"(?:0123456789|1234567890|9876543210)")
_NANP = _re(r"^[2-9]\d{2}[2-9]\d{6}\Z")


def e164_valid(raw: str) -> bool:
    m = _E164_RE.match(raw)
    if not m:
        return False
    digits = m.group(1)
    if _ALL_SAME.match(digits) or _E164_SEQ.search(digits):
        return False
    if digits[0] == "0":
        return False
    if digits[0] == "1":
        nat = digits[1:]
        return len(nat) == 10 and bool(_NANP.match(nat))
    for cc_len in (3, 2):
        cc = digits[:cc_len]
        if cc in _E164_LENGTHS:
            return (len(digits) - cc_len) in _E164_LENGTHS[cc]
    return 10 <= len(digits) <= 15


def ipv4_public(raw: str) -> bool:
    try:
        parts = [int(p) if p.strip() else 0 for p in raw.split(".")]
    except ValueError:
        return False
    if len(parts) != 4 or any(not (0 <= p <= 255) for p in parts):
        return False
    a, b = parts[0], parts[1]
    if a == 0 or a == 10 or a == 127 or a >= 224:
        return False
    if a == 169 and b == 254:
        return False
    if a == 172 and 16 <= b <= 31:
        return False
    if a == 192 and b == 168:
        return False
    if a == 100 and 64 <= b <= 127:
        return False
    if a == 192 and b == 0:
        return False
    if a == 198 and b in (18, 19, 51):
        return False
    if a == 203 and b == 0:
        return False
    return True


# ---------------------------------------------------------------------------
# E-mail
# ---------------------------------------------------------------------------

_FILE_TLDS = frozenset("png jpg jpeg gif svg webp ico bmp js mjs cjs ts tsx jsx css scss map json html htm md txt py rb go rs java lock yml yaml toml xml pdf zip gz tgz wasm node so dll".split())
_EMAIL_LOCAL_SKIP = frozenset(["git", "noreply", "no-reply"])
_PRIVATE_TLDS = frozenset("internal local localdomain localhost lan intranet corp home invalid".split())
_LOCAL_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._%+-")
_EMAIL_DOMAIN = _re(r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])")
_PORT_NEXT = _re(r"^:\d")


def _is_local_char(c: str) -> bool:
    return c in _LOCAL_CHARS


def _is_alnum(c: str) -> bool:
    return ("0" <= c <= "9") or ("A" <= c <= "Z") or ("a" <= c <= "z")


def _email_ok(v: str, text: str, index: int) -> bool:
    # user@host inside a URL (scheme://user@host) is not an e-mail address
    if index >= 3 and text[index - 3:index] == "://":
        return False
    if _PORT_NEXT.match(text[index + len(v):index + len(v) + 2]):
        return False
    at = v.index("@")
    local = v[:at].lower()
    tld = v[v.rindex(".") + 1:].lower()
    if local in _EMAIL_LOCAL_SKIP:
        return False
    if tld in _FILE_TLDS or tld in _PRIVATE_TLDS:
        return False
    if ".." in v:
        return False
    return True


def _find_emails(text: str, check: Callable[[str, str, int], bool], out: List[Tuple[int, int]]) -> None:
    at = text.find("@")
    while at >= 0:
        s = at
        while s > 0 and at - s < 64 and _is_local_char(text[s - 1]):
            s -= 1
        boundary_ok = s == 0 or not _is_local_char(text[s - 1])
        if s < at and boundary_ok and _is_alnum(text[s]) and _is_alnum(text[at - 1]):
            m = _EMAIL_DOMAIN.match(text, at + 1)
            if m:
                v = text[s:at + 1 + len(m.group(0))]
                if check(v, text, s):
                    out.append((s, s + len(v)))
        at = text.find("@", at + 1)


# ---------------------------------------------------------------------------
# Personal fields found from an explicit key (name, address, username)
# ---------------------------------------------------------------------------

_NOT_EOL = r"[^\n\r\u2028\u2029]"
_KEYED_PLACEHOLDER = _re(
    (r"^(?:\{DOT*\}|\$DOT*|<DOT*>|\[DOT*\]|%[sd]|__ZN_DOT*|null|undefined|none|nil|true|false|n/a|na|"
     r"anonymous|unknown|-+|\*+|x+)\Z").replace("DOT", _NOT_EOL), re.I)
_NOT_A_PERSON = frozenset((
    "root admin administrator system guest default test tester user username name bot ci runner ubuntu "
    "ec2-user nobody www-data service me self github-actions dependabot example git postgres mysql nginx deploy"
).split())
_NAME_PARTICLES = frozenset("de del la van von da di bin al el y".split())
_WS_SPLIT = re.compile(_WS_CLASS + "+")
_WS_END = re.compile(_WS_CLASS + "*\\Z")
_USERNAME = _re(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,63}\Z")
_UUID_START = _re(r"^[0-9a-f]{8}-[0-9a-f]{4}-", re.I)
_URLISH = _re(r"://|@")
_HEX_START = _re(r"^0x", re.I)
_ADDR_SPLIT = re.compile("[" + _WS.replace("\v", "\\v").replace("\f", "\\f") + ",]+")
_PERCENT_OK = re.compile(r"%(?![0-9A-Fa-f]{2})")


def _js_strip(s: str) -> str:
    return s.strip(_WS)


def _is_letter(c: str) -> bool:
    return unicodedata.category(c).startswith("L")


def _decode_form_value(v: str) -> str:
    s = v.replace("+", " ")
    if _PERCENT_OK.search(s):
        return s
    try:
        return unquote(s, errors="strict")
    except UnicodeDecodeError:
        return s


def _is_name_word(w: str) -> bool:
    # /^\p{L}[\p{L}'.-]*$/u
    return bool(w) and _is_letter(w[0]) and all(_is_letter(c) or c in "'.-" for c in w[1:])


def _valid_person_name(d: str, strong: bool) -> bool:
    if len(d) < 2 or len(d) > 80:
        return False
    words = [w for w in _WS_SPLIT.split(_js_strip(d))]
    if len(words) > 5:
        return False
    for w in words:
        if not _is_name_word(w):
            return False
    if len(words) == 1:
        return strong and len(words[0]) >= 2 and words[0].lower() not in _NOT_A_PERSON
    if strong:
        return True
    # generic key (name=): every word capitalised, so build names stay out
    return all(unicodedata.category(w[0]) == "Lu" or w.lower() in _NAME_PARTICLES for w in words)


def _valid_username(d: str, strong: bool = True) -> bool:
    if not _USERNAME.match(d):
        return False
    if d.isascii() and d.isdigit() or d.lower() in _NOT_A_PERSON:
        return False
    if _UUID_START.match(d):
        return False
    return True


def _two_letters(d: str) -> bool:
    return any(_is_letter(a) and _is_letter(b) for a, b in zip(d, d[1:], strict=False))


def _valid_address(d: str, strong: bool = True) -> bool:
    if len(d) < 6 or len(d) > 160 or _URLISH.search(d) or _HEX_START.match(d):
        return False
    tokens = [t for t in _ADDR_SPLIT.split(d) if t]
    return len(tokens) >= 2 and any("0" <= c <= "9" for c in d) and _two_letters(d)


def _keyed_finder(headers: List[str], forms: List[str], valid: Callable[[str, bool], bool]):
    hdr = _re("(?<![A-Za-z0-9_-])(" + "|".join(headers) + ")[\"']?[ \\t]*:[ \\t]*([\"']?)", re.I)
    frm = _re("(?<![A-Za-z0-9_.-])(" + "|".join(forms) + ")=", re.I)

    def accept(raw: str, strong: bool, form: bool) -> bool:
        if not raw:
            return False
        d = _js_strip(_decode_form_value(raw) if form else raw)
        if _KEYED_PLACEHOLDER.match(d):
            return False
        return valid(d, strong)

    def letter_at(text: str, i: int) -> bool:
        return 0 <= i < len(text) and _is_letter(text[i])

    def find(text: str, check: Any, out: List[Tuple[int, int]]) -> None:
        pos = 0
        while True:
            m = hdr.search(text, pos)
            if m is None:
                break
            start = m.end()
            quote = m.group(2)
            i = start
            n = len(text)
            while i < n:
                c = text[i]
                if c in "\n\r\"":
                    break
                if quote and c == quote:
                    break
                if c == "'" and not (letter_at(text, i - 1) and letter_at(text, i + 1)):
                    break
                i += 1
            end = i
            while end > start and (text[end - 1] in _WS or text[end - 1] in ",;\\"):
                end -= 1
            if end > start and accept(text[start:end], True, False):
                out.append((start, end))
            pos = max(m.end(), i)
        pos = 0
        while True:
            m = frm.search(text, pos)
            if m is None:
                break
            pos = m.end()
            key = m.group(1)
            k_start = m.start()
            before = text[k_start - 1] if k_start > 0 else "\n"
            query = before in "?&"
            if not query and before not in "\n\r":
                continue
            if not query and key == key.upper():  # USER=... style environment variables
                continue
            start = k_start + len(key) + 1
            i = start
            n = len(text)
            while i < n:
                c = text[i]
                if c in "\n\r&\"'":
                    break
                if query and c in " \t#":
                    break
                i += 1
            end = i
            while end > start and (text[end - 1] in _WS or text[end - 1] in ",;"):
                end -= 1
            strong = key.lower() != "name"
            if end > start and accept(text[start:end], strong, True):
                out.append((start, end))
            pos = max(pos, i)

    return find


# Same language as /X-[A-Za-z-]{4,16}\s*["']?\s*:/ in patterns.js, written so that a long run of
# spaces after "X-abcd" cannot be tried twice (the JavaScript form is quadratic there).
_KEYED_PREFILTER = _re("X-[A-Za-z-]{4,16}" + _WS_CLASS + "*(?:[\"']" + _WS_CLASS + "*)?:|(?:name|user|login|address)=", re.I)
_find_person_name = _keyed_finder(["X-User-?Name", "X-Full-?Name"], ["full_?name", "name"], _valid_person_name)
_find_username = _keyed_finder(["X-Username", "X-User", "X-Forwarded-User", "X-Remote-User"],
                               ["username", "user", "login"], _valid_username)
_find_postal_address = _keyed_finder(["X-Address"], ["address"], _valid_address)


# ---------------------------------------------------------------------------
# The PII list, in the order of patterns.js
# ---------------------------------------------------------------------------

def _card_check(v: str, text: str, index: int) -> bool:
    seps = set(re.findall(r"[ -]", v))
    if len(seps) > 1:
        return False
    return card_valid(v)


# (type, key, hints, prefilter, regex, finder, check)
_PII: List[Dict[str, Any]] = [
    {"type": "EMAIL", "key": "email", "hints": ["@"], "find": _find_emails, "check": _email_ok},
    {"type": "PHONE", "key": "phone", "hints": ["+"],
     "re": _re(r"(?<![A-Za-z0-9+])\+[1-9]\d{7,14}(?![0-9])"), "check": lambda v, t, i: e164_valid(v)},
    {"type": "IBAN", "key": "iban", "prefilter": _re(r"[A-Z]{2}\d{2}"),
     "re": _re(r"(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?(?![A-Za-z0-9])"),
     "check": lambda v, t, i: iban_valid(v)},
    {"type": "CARD", "key": "card", "prefilter": _re(r"\d{4}"),
     "re": _re(r"(?<![0-9A-Za-z.,_-])(?:\d{4}[ -]?){2,3}\d{1,4}(?:[ -]?\d{1,3})?(?![0-9A-Za-z_]|[.,]\d)"),
     "check": _card_check},
    {"type": "DNI", "key": "dni", "prefilter": _re(r"\d{8}-?[A-Za-z]"),
     "re": _re(r"(?<![A-Za-z0-9_.-])\d{8}-?[A-Z](?![A-Za-z0-9_])"), "check": lambda v, t, i: dni_valid(v)},
    {"type": "NIE", "key": "dni", "hints": ["X", "Y", "Z"],
     "re": _re(r"(?<![A-Za-z0-9_.-])[XYZ]-?\d{7}-?[A-Z](?![A-Za-z0-9_])"), "check": lambda v, t, i: nie_valid(v)},
    {"type": "SSN", "key": "ssn", "hints": ["-"],
     "re": _re(r"(?<![0-9A-Za-z.-])\d{3}-\d{2}-\d{4}(?![0-9A-Za-z]|-\d)"), "check": lambda v, t, i: ssn_valid(v)},
    {"type": "IPV4", "key": "ipv4", "hints": ["."],
     "re": _re(r"(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9.])"), "check": lambda v, t, i: ipv4_public(v)},
    {"type": "PERSON_NAME", "key": "name", "prefilter": _KEYED_PREFILTER, "find": _find_person_name},
    {"type": "POSTAL_ADDRESS", "key": "address", "prefilter": _KEYED_PREFILTER, "find": _find_postal_address},
    {"type": "USERNAME", "key": "username", "prefilter": _KEYED_PREFILTER, "find": _find_username},
]

PII_DEFAULTS: Dict[str, bool] = {
    "email": True, "phone": True, "iban": True, "card": True, "dni": True, "ssn": True,
    "ipv4": False, "name": True, "address": True, "username": True,
}
PII_TYPES: List[str] = [p["type"] for p in _PII]


def _has_hint(text: str, p: Dict[str, Any]) -> bool:
    pre = p.get("prefilter")
    if pre is not None:
        return pre.search(text) is not None
    return any(h in text for h in p["hints"])


def _enabled(pii: Any) -> Optional[Dict[str, bool]]:
    if pii is False:
        return None
    enabled = dict(PII_DEFAULTS)
    if isinstance(pii, dict):
        enabled.update(pii)
    return enabled


def _find_in(text: str, enabled: Dict[str, bool]) -> List[Span]:
    spans: List[Span] = []
    for p in _PII:
        if not enabled.get(p["key"]):
            continue
        if not _has_hint(text, p):
            continue
        finder = p.get("find")
        if finder is not None:
            found: List[Tuple[int, int]] = []
            finder(text, p.get("check"), found)
            for s, e in found:
                spans.append({"start": s, "end": e, "type": p["type"], "source": "pii"})
            continue
        for m in p["re"].finditer(text):
            if m.end() == m.start():
                continue
            check = p.get("check")
            if check and not check(m.group(0), text, m.start()):
                continue
            spans.append({"start": m.start(), "end": m.end(), "type": p["type"], "source": "pii"})
    return spans


def _resolve_overlaps(spans: List[Span]) -> List[Span]:
    """Overlapping spans form a cluster: one that covers it all wins (the longest),
    otherwise the cluster becomes one merged span, so no byte of a value survives."""
    spans.sort(key=lambda s: (s["start"], -s["end"]))
    out: List[Span] = []
    cluster: Optional[Dict[str, Any]] = None

    def flush() -> None:
        if cluster is None:
            return
        start, end, members = cluster["start"], cluster["end"], cluster["members"]
        if len(members) == 1:
            out.append(members[0])
            return
        covering = [m for m in members if m["start"] == start and m["end"] == end]
        pool = covering or members
        best = pool[0]
        for m in pool:
            if m["end"] - m["start"] > best["end"] - best["start"]:
                best = m
        if covering:
            out.append(best)
            return
        out.append({"start": start, "end": end, "type": best["type"], "source": best["source"], "merged": True})

    for s in spans:
        if cluster is None or s["start"] >= cluster["end"]:
            flush()
            cluster = {"start": s["start"], "end": s["end"], "members": [s]}
        else:
            cluster["end"] = max(cluster["end"], s["end"])
            cluster["members"].append(s)
    flush()
    return out


def _clean(s: Span) -> Span:
    out = {"start": s["start"], "end": s["end"], "type": s["type"], "source": s["source"]}
    if s.get("merged"):
        out["merged"] = True
    return out


def find_pii(text: str, pii: Any = None) -> List[Span]:
    """Spans of personal data in `text`, sorted by position. See the module docstring."""
    if not isinstance(text, str):
        raise TypeError("find_pii(text, pii): text must be a string")
    enabled = _enabled(pii)
    if not text or enabled is None:
        return []
    # Invisible characters can split a value: scan the text as it is and without
    # them, map the second result back, and resolve the union (as scan() does).
    direct = [_clean(s) for s in _resolve_overlaps(_find_in(text, enabled))]
    view = invisible_view(text)
    if not view:
        return direct
    clean, mapping = view
    via_view = []
    for s in _resolve_overlaps(_find_in(clean, enabled)):
        start = mapping[s["start"]]
        end = mapping[s["end"] - 1] + 1 if s["end"] > s["start"] else mapping[s["start"]]
        via_view.append(dict(s, start=start, end=end))
    return [_clean(s) for s in _resolve_overlaps(direct + via_view)]


def redact_pii(text: str, pii: Any = None) -> Tuple[str, List[Span]]:
    """`text` with every personal value replaced by __ZN_REDACTED_<TYPE>__, and the spans found."""
    spans = find_pii(text, pii)
    if not spans:
        return text, []
    out: List[str] = []
    last = 0
    for s in spans:
        out.append(text[last:s["start"]])
        out.append("__ZN_REDACTED_%s__" % s["type"])
        last = s["end"]
    out.append(text[last:])
    return "".join(out), spans
