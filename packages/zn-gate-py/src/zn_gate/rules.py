"""
zn deterministic rules engine - Python stdlib implementation.
RULES_VERSION: 2026-10-29.4
Zero external dependencies. Pure Python stdlib.

The pattern constants in this module compile on first use: they are lazy proxies with the re.Pattern
methods the rules call (search, match, finditer, sub...), not re.Pattern objects, and they are internal,
not public API. Do not pass them to re.* functions or isinstance(x, re.Pattern).
"""

from __future__ import annotations

import base64
import binascii
import bisect
from array import array
import json
import math
import os
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, TypedDict, cast, overload


RULES_VERSION = "2026-10-29.4"

# Word boundaries are written as explicit ASCII lookarounds, not \b: Python's \b
# is Unicode, JavaScript's is ASCII-only. Same patterns as rules.js.
# Under re.IGNORECASE, Python also folds four non-ASCII characters into ASCII
# letters (U+0130, U+0131, U+017F, U+212A); JavaScript does not. The raw input
# target has them replaced by NUL first, so both engines agree. The normalized
# texts are not guarded: U+0130 and U+0131 are mapped to I and i, and U+017F and
# U+212A are folded to s and K by the compatibility fold.
_CASE_FOLD_GUARD = str.maketrans({'İ': '\x00', 'ı': '\x00', 'ſ': '\x00', 'K': '\x00'})
# Compatibility characters folded for matching, one at a time (same ranges as
# COMPAT_FOLD in rules.js; full NFKC expands some characters to 18). The table
# maps code points to their folded text and is applied with str.translate.
_COMPAT_FOLD_TABLE: Dict[int, str] = {}
for _lo, _hi in ((0xFF01, 0xFF5E), (0xFB00, 0xFB06), (0x017F, 0x017F), (0x212A, 0x212A),
                 (0x2070, 0x209F), (0x2460, 0x24FF), (0x1D400, 0x1D7FF)):
    for _cp in range(_lo, _hi + 1):
        _folded = unicodedata.normalize('NFKC', chr(_cp))
        if _folded != chr(_cp):
            _COMPAT_FOLD_TABLE[_cp] = _folded

# Cyrillic homoglyphs mapping to Latin
HOMOGLYPH_MAP = {
    '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
    '\u0456': 'i', '\u0455': 's', '\u0443': 'y', '\u0445': 'x',
    '\u0410': 'A', '\u0415': 'E', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C',
    # Dotless i and capital dotted I read as i and I.
    '\u0131': 'i', '\u0130': 'I',
}
# Homoglyphs as a translation table (str.translate runs in C).
_HOMOGLYPH_TABLE = {ord(k): v for k, v in HOMOGLYPH_MAP.items()}

# Rule patterns mirror packages/zn-gate/lib/rules.js: the source strings are
# identical (tests/test_rules_parity.py compares them) and the JavaScript "i"
# flag maps to re.IGNORECASE. Every pattern runs in linear time: no unbounded
# lazy wildcards, and repeated character classes are bounded.
class _LazyPattern:
    """A regex that is compiled on first use and then behaves as the compiled pattern.

    Importing this module defines a few hundred patterns; compiling them all up
    front cost about a third of the import time even though most calls never
    reach most of them. `pattern` is available at once; any other attribute
    (`search`, `sub`, `flags`, ...) compiles the pattern and is then served
    straight from the instance, so later calls cost the same as a real compiled
    pattern.
    """

    __slots__ = ("pattern", "_flags", "_compiled", "__dict__")

    def __init__(self, pattern: str, flags: int = 0) -> None:
        self.pattern = pattern
        self._flags = flags
        self._compiled: Optional["re.Pattern[str]"] = None

    def _compile(self) -> "re.Pattern[str]":
        compiled = self._compiled
        if compiled is None:
            compiled = self._compiled = re.compile(self.pattern, self._flags)
        return compiled

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        value = getattr(self._compile(), name)
        self.__dict__[name] = value
        return value

    def __repr__(self) -> str:
        return "_LazyPattern(%r, %r)" % (self.pattern, self._flags)


def _rc(pattern: str, flags: int = 0) -> "re.Pattern[str]":
    return cast("re.Pattern[str]", _LazyPattern(pattern, flags))


ZERO_WIDTH_RE = _rc(r'[\u200B-\u200D\u2060\uFEFF\u00AD\uFE00-\uFE0F\u061C\u180E\u200E\u200F\u115F\u1160\u3164\uFFA0]')
INVISIBLE_ASTRAL_RE = _rc(r'[\U000E0000-\U000E007F\U000E0100-\U000E01EF]')
# Line breaks are joined only in texts up to this size (see MAX_WRAP_VIEW_CHARS in rules.js).
MAX_WRAP_VIEW_CHARS = 1 << 20
# A line break inside a wrapped token (see WRAP_BREAK_RE in rules.js).
WRAP_BREAK_RE = _rc(r'(?<=[A-Za-z0-9_\-+/=]{10})[ \t]*\r?\n[ \t]*(?=[A-Za-z0-9_\-+/=]{10})(?![A-Za-z_][A-Za-z0-9_]*[ \t]*[=:](?!=[ \t]*(?:\r?\n|$)))')
NON_ASCII_RE = _rc(r'[^\x00-\x7f]')
ANSI_ESCAPE_RE = _rc(r'\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*\x07')
# Hard caps for the Base64 smuggling check: above either one the command is blocked.
MAX_B64_PAYLOADS = 16
MAX_B64_DECODED_BYTES = 128 * 1024
# The payload is group 2 (echo/printf pipe, quoted or not, with options) or group 4 (here-string).
B64_EXEC_RE = _rc(r'''(?:echo|printf(?:\s+(?:'%s'|"%s"|%s))?)(?:\s+-[A-Za-z]{1,3})*\s+(["']?)([A-Za-z0-9+/=]{16,})\1\s*\|\s*(?:base64\s+-(?:di?|id|-decode)|openssl\s+(?:base64|enc)(?:\s+(?:-[A-Za-z0-9]+|-(?![A-Za-z0-9])))*?\s+-d(?![A-Za-z0-9_]))|base64\s+-(?:di?|id|-decode)\s*<<<\s*(["']?)([A-Za-z0-9+/=]{16,})\3''', re.IGNORECASE)
# Maximal whitespace runs; only runs that contain a line break are joined.
# A pattern anchored on the line break (such as [^\S\r\n]*[\r\n]) would rescan
# a long run of spaces from every position.
WHITESPACE_RUN_RE = _rc(r'\s+')
_JOIN_EXTRA_LEFT = frozenset('_<|/.-')
_JOIN_EXTRA_RIGHT = frozenset('_>|/.-')

# "ignore" and "disregard" are ordinary words ("ignore the noise in the logs",
# "ignore whitespace changes"). They only count as an override when they name
# what to ignore: instructions, prompts, rules, guardrails... with a qualifier
# (previous, above, system...) or a quantifier (all, any, your...), or point
# back at earlier text ("ignore the above", "everything before"). Every group
# is a fixed list of words and whitespace runs are bounded, so a match
# attempt does bounded work.
_OVERRIDE_NOUN = r'(?:instructions?|prompts?|rules|guidelines?|directives?|guidance|restrictions?|guardrails?|context|constraints?|commands?|policies|programming|orders|limitations?|directions|requests?|tasks?)(?![A-Za-z0-9_])'
_OVERRIDE_QUANTIFIER = r'(?:all|any|every|each|your|my|these|those)(?:\s{1,32}of)?\s{1,32}'
_OVERRIDE_DETERMINER = r'(?:(?:the|your|my|these|those|our|its|their)\s{1,32})?'
_OVERRIDE_QUALIFIER = r'(?:previous|prior|above|earlier|preceding|foregoing|original|initial|existing|system|safety|security|former|developer)\s{1,32}'
# "ignore the above" / "ignore previous" without a noun counts only at the end
# of a clause, before "and" or before a word for text ("ignore the above
# text"), so "ignore the previous build output" stays allowed.
_OVERRIDE_END = r'(?=[ \t]*(?:[.,;:!)\r\n]|$)|\s{1,32}and(?![A-Za-z0-9_])|\s{1,32}(?:text|content|message|messages|input|lines?|one|ones)(?![A-Za-z0-9_]))'


def _override_rule_source(verb: str) -> str:
    return '|'.join([
        verb + r'\s{1,32}(?:' + _OVERRIDE_QUANTIFIER + r')?' + _OVERRIDE_DETERMINER + r'(?:' + _OVERRIDE_QUALIFIER + r'){1,2}' + _OVERRIDE_NOUN,
        verb + r'\s{1,32}' + _OVERRIDE_QUANTIFIER + _OVERRIDE_DETERMINER + _OVERRIDE_NOUN,
        verb + r'\s{1,32}(?:the\s{1,32})?(?:instructions|guardrails|directives)(?![A-Za-z0-9_])',
        verb + r'\s{1,32}(?:' + _OVERRIDE_QUANTIFIER + r')?(?:the\s{1,32})?(?:previous|prior|above|earlier|preceding|foregoing)' + _OVERRIDE_END,
        verb + r"\s{1,32}(?:everything|anything|all)\s{1,32}(?:above|before|previously|prior|earlier|you(?:'ve|\s{1,32}have|\s{1,32}were|\s{1,32}was)?\s{1,32}(?:been\s{1,32})?(?:told|said|given|received))(?![A-Za-z0-9_])",
    ])


# Russian and Chinese rules: a verb followed, within 80 characters on the same
# line, by an object ("забудь ... инструкции", "忽略 ... 指令"). A regex such as
# 忽略[^\n]{0,80}?(指令) is linear but reads up to 80 characters from every
# verb, which is slow on a long run of verbs. _near_match() scans the verbs and
# the objects once each and compares their positions.
NEAR_MAX_GAP = 80
RU_FORGET_RE = _rc(r'забудь\s+', re.IGNORECASE)
RU_FORGET_OBJECT_RE = _rc(r'все|инструкции', re.IGNORECASE)
RU_IGNORE_RE = _rc(r'игнорируй\s+', re.IGNORECASE)
RU_IGNORE_OBJECT_RE = _rc(r'все|предыдущие', re.IGNORECASE)
RU_PHRASE_RE = _rc(r'действуй\s+как|ты\s+теперь|найди\s+пароли', re.IGNORECASE)
ZH_IGNORE_RE = _rc(r'忽略')
ZH_IGNORE_OBJECT_RE = _rc(r'指示|指令|提示')
ZH_FORGET_RE = _rc(r'忘记')
ZH_FORGET_OBJECT_RE = _rc(r'指示|指令|一切')
ZH_PHRASE_RE = _rc(r'你现在是|初始提示词')


def _near_match(text: str, verb_re: re.Pattern[str], object_re: re.Pattern[str]) -> bool:
    """True when an object match starts at most NEAR_MAX_GAP characters after
    the end of a verb match, with no line break in between. Linear: the object
    search only restarts past the last object found."""
    obj = None
    for v in verb_re.finditer(text):
        end = v.end()
        if obj is None or obj.start() < end:
            obj = object_re.search(text, end)
            if obj is None:
                return False
        if obj.start() - end <= NEAR_MAX_GAP and '\n' not in text[end:obj.start()]:
            return True
    return False


def _test_multi_ru(text: str) -> bool:
    return bool(RU_PHRASE_RE.search(text)) or _near_match(text, RU_FORGET_RE, RU_FORGET_OBJECT_RE) \
        or _near_match(text, RU_IGNORE_RE, RU_IGNORE_OBJECT_RE)


def _test_multi_zh(text: str) -> bool:
    return bool(ZH_PHRASE_RE.search(text)) or _near_match(text, ZH_IGNORE_RE, ZH_IGNORE_OBJECT_RE) \
        or _near_match(text, ZH_FORGET_RE, ZH_FORGET_OBJECT_RE)


INJECTION_RULES: List[Tuple[str, re.Pattern[str], str]] = [
    ('pi:ignore_previous', _rc(_override_rule_source('ignore'), re.IGNORECASE), 'Override prior instructions'),
    ('pi:disregard', _rc(_override_rule_source('disregard'), re.IGNORECASE), 'Disregard instructions'),
    ('pi:forget', _rc(r"""(?<![A-Za-z0-9_])forget\s+(?:about\s+)?(?:everything|all|your)(?![A-Za-z0-9_])(?!\s+(?:of\s+)?(?:the\s+)?(?:cached?|caches|entries|changes|data|files?|records|sessions?|cookies|state|tabs|devices?|passwords?|history|items|keys|tokens|credentials|settings|preferences|accounts?|connections?|logins?|networks?)(?![A-Za-z0-9_]))""", re.IGNORECASE), 'Forget-context attack'),
    ('pi:identity_override', _rc(r'you\s+are\s+now', re.IGNORECASE), 'Identity override'),
    ('pi:new_instructions', _rc(r'new\s+instructions?:', re.IGNORECASE), 'Instruction replacement'),
    ('pi:system_tag', _rc(r"""(?:^|[\r\n"'`\[<])[ \t]*system\s*:|<[\s/]*system(?![A-Za-z0-9_])[^<>]*>""", re.IGNORECASE), 'Fake system tag'),
    ('pi:system_bracket', _rc(r'\[system\]', re.IGNORECASE), 'Bracketed system tag'),
    ('pi:act_as', _rc(r"""(?:(?<![A-Za-z0-9_])you\s+(?:(?:will|must|should|shall|now)\s+|are\s+to\s+)?|(?:^|[.!?\r\n\u2028\u2029])[ \t]*(?:[\"'`(\[*-][ \t]*)?|(?<![A-Za-z0-9_])please\s+|(?<![A-Za-z0-9_])now\s+|(?<![A-Za-z0-9_])from\s+now\s+on,?\s+(?:you\s+)?)(?=act(?![A-Za-z0-9_]))act\s+as\s+(?:if\s+you(?![A-Za-z0-9_])|an?\s+(?:[a-z-]+\s+){0,3}?(?:ai|assistant|chatbot|bot|model|llm|gpt|persona|character|version|mode|jailbroken|unrestricted|unfiltered|uncensored|evil|malicious|rogue|harmful|unethical|amoral|hacker|dan)(?![A-Za-z0-9_])|my(?![A-Za-z0-9_])|though\s+you(?![A-Za-z0-9_]))""", re.IGNORECASE), 'Role hijack (act as)'),
    ('pi:pretend', _rc(r'pretend\s+(you|to\s+be)', re.IGNORECASE), 'Role hijack (pretend)'),
    ('pi:roleplay', _rc(r'roleplay\s+as', re.IGNORECASE), 'Role hijack (roleplay)'),
    ('pi:jailbreak', _rc(r'(?<![A-Za-z0-9_])jailbreak(?![A-Za-z0-9_])', re.IGNORECASE), 'Explicit jailbreak term'),
    ('pi:bypass', _rc(r'bypass\s+(your|the|all)', re.IGNORECASE), 'Guardrail bypass attempt'),
    ('pi:override', _rc(r'(?<![A-Za-z0-9_])override\s+(?:all\s+|your\s+|the\s+)?(?:system|policy|safety|rules|instructions|guidelines|restrictions)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])system\s+override\s*:', re.IGNORECASE), 'Policy override attempt'),
    ('pi:template_boundary', _rc(r'\[INST\]|\[\/INST\]|<<<SYS>>>|<\/<<SYS>>>|<\|im_start\|>|<\|im_end\|>', re.IGNORECASE), 'Chat template boundary injection'),
    ('pi:multi_es', _rc(r'ignora\s+(todas\s+las\s+)?(instrucciones|anteriores|previas)|olvida\s+(todo|las\s+instrucciones)|act[uú]a\s+como|ahora\s+eres', re.IGNORECASE), 'Multilingual prompt injection (Spanish)'),
    ('pi:multi_pt', _rc(r'ignor(?:e|a|em|ar)\s+(?:(?:todas|todos|qualquer|quaisquer|cualquier)\s+)?(?:(?:as|os|las|los|suas|seus|sus|tus|estas|estes|essas|esses)\s+)?(?:instru[cç][oõ]es|instrucciones|regras|reglas|diretrizes|directrices|orienta[cç][oõ]es|ordens|[oó]rdenes|comandos|restri[cç][oõ]es|restricciones|mensagens|anteriores|pr[eé]vias)|ignore\s+(?:tudo|qualquer|quaisquer)(?![A-Za-z0-9_])|ignora\s+(?:todo|tudo|cualquier)(?![A-Za-z0-9_])', re.IGNORECASE), 'Multilingual prompt injection (Portuguese)'),
    ('pi:multi_fr', _rc(r'ignore[rz]?\s+(toutes\s+les\s+)?instructions|oublie[rz]?\s+tout|agis\s+comme|tu\s+es\s+maintenant', re.IGNORECASE), 'Multilingual prompt injection (French)'),
    ('pi:multi_de', _rc(r'ignoriere\s+(alle\s+)?(anweisungen|instruktionen)|vergiss\s+(alles|jede)|du\s+bist\s+jetzt|handle\s+als', re.IGNORECASE), 'Multilingual prompt injection (German)'),
    ('pi:multi_ru', _rc(r'забудь\s+[^\n]{0,80}?(все|инструкции)|игнорируй\s+[^\n]{0,80}?(все|предыдущие)|действуй\s+как|ты\s+теперь|найди\s+пароли', re.IGNORECASE), 'Multilingual prompt injection (Russian)'),
    ('pi:multi_zh', _rc(r'忽略[^\n]{0,80}?(指示|指令|提示)|忘记[^\n]{0,80}?(指示|指令|一切)|你现在是|初始提示词'), 'Multilingual prompt injection (Chinese)'),
    ('pi:identity_request', _rc(r"""(?<![A-Za-z0-9_])(?<!never\s)(?<!not\s)(?<!n't\s)(?<!n\u2019t\s)(?<!avoid\s)(?:run|execute|invoke|call)\s{1,4}[\x60\x27\x22]{0,2}(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))(?![A-Za-z0-9_.-])[^\n]{0,100}?(?:\n[^\n]{0,100}?)?(?<![A-Za-z0-9_])(?:include|add|put|attach|append|insert|embed|send|pass|forward|submit|post|write|place|share|transmit|inject|encode|set)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:http\s{1,4}|request\s{1,4}|custom\s{1,4}|response\s{1,4})?headers?|(?<![A-Za-z0-9_])x-[a-z0-9-]{1,40}|url\s{1,4}param(?:eter)?s?|query\s{1,4}(?:string|param(?:eter)?s?)|\?[a-z_]{1,20}=|cookies?|form\s{1,4}(?:fields?|inputs?|data)|request\s{1,4}(?:body|payload)|next\s{1,4}(?:request|call|message)|(?:in|into|inside|within|with|to|on)\s{1,4}(?:an?|the|your|every|each|any|all|subsequent|following|outgoing|next)\s{1,4}(?:(?:http|outgoing|network|api|subsequent|following)\s{1,4}){0,2}(?:requests?|calls?))|(?<![A-Za-z0-9_])(?<!never\s)(?<!not\s)(?<!n't\s)(?<!n\u2019t\s)(?<!avoid\s)(?:include|add|put|attach|append|insert|embed|send|pass|forward|submit|post|write|place|share|transmit|inject|encode|set)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:output|result|value)\s{1,4}of\s{1,4}[\x60\x27\x22]{0,2}(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))(?![A-Za-z0-9_.-])|[\x60\x27\x22]{0,2}(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))[\x60\x27\x22]{0,2}\s{1,4}(?:output|result))(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:http\s{1,4}|request\s{1,4}|custom\s{1,4}|response\s{1,4})?headers?|(?<![A-Za-z0-9_])x-[a-z0-9-]{1,40}|url\s{1,4}param(?:eter)?s?|query\s{1,4}(?:string|param(?:eter)?s?)|\?[a-z_]{1,20}=|cookies?|form\s{1,4}(?:fields?|inputs?|data)|request\s{1,4}(?:body|payload)|next\s{1,4}(?:request|call|message)|(?:in|into|inside|within|with|to|on)\s{1,4}(?:an?|the|your|every|each|any|all|subsequent|following|outgoing|next)\s{1,4}(?:(?:http|outgoing|network|api|subsequent|following)\s{1,4}){0,2}(?:requests?|calls?))|(?<![A-Za-z0-9_])(?<!never\s)(?<!not\s)(?<!n't\s)(?<!n\u2019t\s)(?<!avoid\s)(?:include|add|put|attach|append|insert|embed|set|send|pass|forward|submit|post|write|specify|provide|supply|encode|inject|place|share|transmit|reveal|disclose|expose)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:(?:the|your)\s{1,4}(?:end\s{1,4})?(?:user|operator|owner|human|principal)\s{1,4}(?:(?:full|real|login|primary)\s{1,4})?(?:names?|e-?mail(?:\s{1,4}address(?:es)?)?|phone(?:\s{1,4}number)?)|their\s{1,4}(?:(?:primary|login|account|real)\s{1,4})?e-?mail(?:\s{1,4}address(?:es)?)?(?=[^\n]{0,80}?(?:(?<![A-Za-z0-9_])x-[a-z0-9-]{1,40}|next\s{1,4}(?:http\s{1,4})?(?:request|call)))(?!(?:(?!(?<![A-Za-z0-9_])x-[a-z0-9-]|next\s)[^\n]){0,80}?(?:user-agent|mailto|(?<![A-Za-z0-9_])from\s{1,4}h[a-z]{3,5}|(?:request\s{1,4})?(?:body|payload)|(?<![A-Za-z0-9_])form(?![A-Za-z0-9_])))|(?:(?:your|the)\s{1,4}(?:end\s{1,4})?(?:user|operator|owner|human|principal)|your\s{1,4}(?:end\s{1,4})?(?:customer|account\s{1,4}holder))[\x27’]s\s{1,4}(?:(?:full|real|first|last|login|primary|account|email|e-mail)\s{1,4}){0,2}(?:names?|e-?mail(?:\s{1,4}address(?:es)?)?|usernames?|user\s{0,2}ids?|accounts?|api[\s-]{0,2}keys?|access\s{1,4}tokens?|tokens?|credentials?|passwords?|logins?|identity|identifier|phone(?:\s{1,4}number)?|address|keys?|secrets?)|(?:(?:full|real|first|last|login|primary|account|email|e-mail)\s{1,4}){0,2}(?:names?|e-?mail(?:\s{1,4}address(?:es)?)?|usernames?|user\s{0,2}ids?|accounts?|api[\s-]{0,2}keys?|access\s{1,4}tokens?|tokens?|credentials?|passwords?|logins?|identity|identifier|phone(?:\s{1,4}number)?|address|keys?|secrets?)\s{1,4}(?:of|for)\s{1,4}(?:(?:your|the)\s{1,4}(?:end\s{1,4})?(?:user|operator|owner|human|principal)|your\s{1,4}(?:end\s{1,4})?(?:customer|account\s{1,4}holder)))(?![A-Za-z0-9_])[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:(?:http\s{1,4}|request\s{1,4}|custom\s{1,4}|response\s{1,4})?headers?|x-[a-z0-9-]{1,40}|url\s{1,4}param(?:eter)?s?|query\s{1,4}(?:string|param(?:eter)?s?)|\?[a-z_]{1,20}=|cookies?|form\s{1,4}(?:fields?|inputs?|data)|(?:request\s{1,4})?(?:body|payload)|next\s{1,4}(?:request|call|message)|(?:subsequent|following|every|each|outgoing)\s{1,4}(?:http\s{1,4})?(?:requests?|calls?|fetch(?:es)?))|(?:(?:http\s{1,4}|request\s{1,4}|custom\s{1,4}|response\s{1,4})?headers?|x-[a-z0-9-]{1,40}|url\s{1,4}param(?:eter)?s?|query\s{1,4}(?:string|param(?:eter)?s?)|\?[a-z_]{1,20}=|cookies?|form\s{1,4}(?:fields?|inputs?|data)|(?:request\s{1,4})?(?:body|payload)|next\s{1,4}(?:request|call|message)|(?:subsequent|following|every|each|outgoing)\s{1,4}(?:http\s{1,4})?(?:requests?|calls?|fetch(?:es)?))[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:(?:the|your)\s{1,4}(?:end\s{1,4})?(?:user|operator|owner|human|principal)\s{1,4}(?:(?:full|real|login|primary)\s{1,4})?(?:names?|e-?mail(?:\s{1,4}address(?:es)?)?|phone(?:\s{1,4}number)?)|their\s{1,4}(?:(?:primary|login|account|real)\s{1,4})?e-?mail(?:\s{1,4}address(?:es)?)?(?=[^\n]{0,80}?(?:(?<![A-Za-z0-9_])x-[a-z0-9-]{1,40}|next\s{1,4}(?:http\s{1,4})?(?:request|call)))(?!(?:(?!(?<![A-Za-z0-9_])x-[a-z0-9-]|next\s)[^\n]){0,80}?(?:user-agent|mailto|(?<![A-Za-z0-9_])from\s{1,4}h[a-z]{3,5}|(?:request\s{1,4})?(?:body|payload)|(?<![A-Za-z0-9_])form(?![A-Za-z0-9_])))|(?:(?:your|the)\s{1,4}(?:end\s{1,4})?(?:user|operator|owner|human|principal)|your\s{1,4}(?:end\s{1,4})?(?:customer|account\s{1,4}holder))[\x27’]s\s{1,4}(?:(?:full|real|first|last|login|primary|account|email|e-mail)\s{1,4}){0,2}(?:names?|e-?mail(?:\s{1,4}address(?:es)?)?|usernames?|user\s{0,2}ids?|accounts?|api[\s-]{0,2}keys?|access\s{1,4}tokens?|tokens?|credentials?|passwords?|logins?|identity|identifier|phone(?:\s{1,4}number)?|address|keys?|secrets?)|(?:(?:full|real|first|last|login|primary|account|email|e-mail)\s{1,4}){0,2}(?:names?|e-?mail(?:\s{1,4}address(?:es)?)?|usernames?|user\s{0,2}ids?|accounts?|api[\s-]{0,2}keys?|access\s{1,4}tokens?|tokens?|credentials?|passwords?|logins?|identity|identifier|phone(?:\s{1,4}number)?|address|keys?|secrets?)\s{1,4}(?:of|for)\s{1,4}(?:(?:your|the)\s{1,4}(?:end\s{1,4})?(?:user|operator|owner|human|principal)|your\s{1,4}(?:end\s{1,4})?(?:customer|account\s{1,4}holder)))(?![A-Za-z0-9_]))|(?<![A-Za-z0-9_])(?:(?:identify|reveal|disclose|state|report|announce)\s{1,4}(?:to\s{1,4}(?:me|us|this\s{1,4}[a-z]{3,10})\s{1,4})?(?:who\s{1,4})?your\s{1,4}(?:user|operator|owner|human|principal)(?:\s{1,4}is)?(?![A-Za-z0-9_])|(?:tell|inform)\s{1,4}(?:me|us)\s{1,4}who\s{1,4}(?:your|the)\s{1,4}(?:user|operator|owner|human|principal)\s{1,4}is(?![A-Za-z0-9_])|(?:tell|state|say|reveal|report)[^\n]{0,20}?who\s{1,4}you(?:\s{1,4}are|\s{0,4}[\x27’]re)\s{1,4}(?:working|acting)\s{1,4}for(?![A-Za-z0-9_]))""", re.IGNORECASE), "Tool result asks the agent to identify its user or put the user identity in a request"),
    ('pi:identity_request_multi', _rc(r"""(?<![A-Za-z0-9_])(?:ejecuta|ejecute|corre|lanza)\s{1,4}[\x60\x27\x22]{0,2}(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))(?![A-Za-z0-9_.-])[^\n]{0,100}?(?:\n[^\n]{0,100}?)?(?<![A-Za-z0-9_])(?:incluye|incluya|a[ñn]ade|a[ñn]ada|agrega|agregue|pon|ponga|env[ií]a|env[ií]e|adjunta|adjunte|inserta|pasa)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:cabecera|encabezado|header|par[aá]metro|cookie|formulario|campo|(?:siguiente|pr[oó]xima)\s{1,4}(?:petici[oó]n|solicitud)|url)|(?<![A-Za-z0-9_])(?:incluye|incluya|incluyas|añade|añada|agrega|agregue|pon|ponga|envía|envia|envíe|adjunta|adjunte|inserta|pasa|indica|comparte|revela)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:(?:usuario|operador|due[ñn]o|propietario)[^\n]{0,30}?(?:correo(?:\s{1,4}electr[oó]nico)?|e-?mail|nombre(?:\s{1,4}completo)?|cuenta|clave(?:\s{1,4}de\s{1,4}api)?|token|credenciales|contrase[ñn]a|identidad)|(?:correo(?:\s{1,4}electr[oó]nico)?|e-?mail|nombre(?:\s{1,4}completo)?|cuenta|clave(?:\s{1,4}de\s{1,4}api)?|token|credenciales|contrase[ñn]a|identidad)[^\n]{0,30}?(?:usuario|operador|due[ñn]o|propietario))[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:cabecera|encabezado|header|par[aá]metro|cookie|formulario|campo|(?:siguiente|pr[oó]xima)\s{1,4}(?:petici[oó]n|solicitud)|url)|(?:cabecera|encabezado|header|par[aá]metro|cookie|formulario|campo|(?:siguiente|pr[oó]xima)\s{1,4}(?:petici[oó]n|solicitud)|url)[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:(?:usuario|operador|due[ñn]o|propietario)[^\n]{0,30}?(?:correo(?:\s{1,4}electr[oó]nico)?|e-?mail|nombre(?:\s{1,4}completo)?|cuenta|clave(?:\s{1,4}de\s{1,4}api)?|token|credenciales|contrase[ñn]a|identidad)|(?:correo(?:\s{1,4}electr[oó]nico)?|e-?mail|nombre(?:\s{1,4}completo)?|cuenta|clave(?:\s{1,4}de\s{1,4}api)?|token|credenciales|contrase[ñn]a|identidad)[^\n]{0,30}?(?:usuario|operador|due[ñn]o|propietario)))|(?:cabecera|encabezado|header|par[aá]metro|cookie|formulario|campo|(?:siguiente|pr[oó]xima)\s{1,4}(?:petici[oó]n|solicitud)|url)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?<![A-Za-z0-9_])(?:incluye|incluya|incluyas|añade|añada|agrega|agregue|pon|ponga|envía|envia|envíe|adjunta|adjunte|inserta|pasa|indica|comparte|revela)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:usuario|operador|due[ñn]o|propietario)[^\n]{0,30}?(?:correo(?:\s{1,4}electr[oó]nico)?|e-?mail|nombre(?:\s{1,4}completo)?|cuenta|clave(?:\s{1,4}de\s{1,4}api)?|token|credenciales|contrase[ñn]a|identidad)|(?:correo(?:\s{1,4}electr[oó]nico)?|e-?mail|nombre(?:\s{1,4}completo)?|cuenta|clave(?:\s{1,4}de\s{1,4}api)?|token|credenciales|contrase[ñn]a|identidad)[^\n]{0,30}?(?:usuario|operador|due[ñn]o|propietario))|(?<![A-Za-z0-9_])(?:inclua|inclui|adicione|adiciona|coloque|coloca|envie|envia|anexe|insira|passe|compartilhe|revele)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:(?:usu[aá]rio|operador|dono|propriet[aá]rio)[^\n]{0,30}?(?:e-?mail|nome(?:\s{1,4}completo)?|conta|chave(?:\s{1,4}de\s{1,4}api)?|token|credenciais|senha|identidade)|(?:e-?mail|nome(?:\s{1,4}completo)?|conta|chave(?:\s{1,4}de\s{1,4}api)?|token|credenciais|senha|identidade)[^\n]{0,30}?(?:usu[aá]rio|operador|dono|propriet[aá]rio))[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:cabe[cç]alho|header|par[aâ]metro|cookie|formul[aá]rio|campo|pr[oó]xima\s{1,4}requisi[cç][aã]o|url)|(?:cabe[cç]alho|header|par[aâ]metro|cookie|formul[aá]rio|campo|pr[oó]xima\s{1,4}requisi[cç][aã]o|url)[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:(?:usu[aá]rio|operador|dono|propriet[aá]rio)[^\n]{0,30}?(?:e-?mail|nome(?:\s{1,4}completo)?|conta|chave(?:\s{1,4}de\s{1,4}api)?|token|credenciais|senha|identidade)|(?:e-?mail|nome(?:\s{1,4}completo)?|conta|chave(?:\s{1,4}de\s{1,4}api)?|token|credenciais|senha|identidade)[^\n]{0,30}?(?:usu[aá]rio|operador|dono|propriet[aá]rio)))|(?:cabe[cç]alho|header|par[aâ]metro|cookie|formul[aá]rio|campo|pr[oó]xima\s{1,4}requisi[cç][aã]o|url)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?<![A-Za-z0-9_])(?:inclua|inclui|adicione|adiciona|coloque|coloca|envie|envia|anexe|insira|passe|compartilhe|revele)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:usu[aá]rio|operador|dono|propriet[aá]rio)[^\n]{0,30}?(?:e-?mail|nome(?:\s{1,4}completo)?|conta|chave(?:\s{1,4}de\s{1,4}api)?|token|credenciais|senha|identidade)|(?:e-?mail|nome(?:\s{1,4}completo)?|conta|chave(?:\s{1,4}de\s{1,4}api)?|token|credenciais|senha|identidade)[^\n]{0,30}?(?:usu[aá]rio|operador|dono|propriet[aá]rio))|(?<![A-Za-z0-9_])(?:inclus|incluez|ajoute|ajoutez|mets|mettez|envoie|envoyez|joins|joignez|insère|insérez|transmets|transmettez|partage|partagez|révèle|révélez)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:(?:utilisateur|opérateur|propriétaire)[^\n]{0,30}?(?:e-?mail|courriel|adresse\s{1,4}e-?mail|nom(?:\s{1,4}complet)?|compte|clé(?:\s{1,4}d\x27api)?|jeton|identifiants?|mot\s{1,4}de\s{1,4}passe|identité)|(?:e-?mail|courriel|adresse\s{1,4}e-?mail|nom(?:\s{1,4}complet)?|compte|clé(?:\s{1,4}d\x27api)?|jeton|identifiants?|mot\s{1,4}de\s{1,4}passe|identité)[^\n]{0,30}?(?:utilisateur|opérateur|propriétaire))[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:en-t[eê]te|header|param[eè]tre|cookie|formulaire|champ|prochaine\s{1,4}requ[eê]te|url)|(?:en-t[eê]te|header|param[eè]tre|cookie|formulaire|champ|prochaine\s{1,4}requ[eê]te|url)[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:(?:utilisateur|opérateur|propriétaire)[^\n]{0,30}?(?:e-?mail|courriel|adresse\s{1,4}e-?mail|nom(?:\s{1,4}complet)?|compte|clé(?:\s{1,4}d\x27api)?|jeton|identifiants?|mot\s{1,4}de\s{1,4}passe|identité)|(?:e-?mail|courriel|adresse\s{1,4}e-?mail|nom(?:\s{1,4}complet)?|compte|clé(?:\s{1,4}d\x27api)?|jeton|identifiants?|mot\s{1,4}de\s{1,4}passe|identité)[^\n]{0,30}?(?:utilisateur|opérateur|propriétaire)))|(?:en-t[eê]te|header|param[eè]tre|cookie|formulaire|champ|prochaine\s{1,4}requ[eê]te|url)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?<![A-Za-z0-9_])(?:inclus|incluez|ajoute|ajoutez|mets|mettez|envoie|envoyez|joins|joignez|insère|insérez|transmets|transmettez|partage|partagez|révèle|révélez)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:utilisateur|opérateur|propriétaire)[^\n]{0,30}?(?:e-?mail|courriel|adresse\s{1,4}e-?mail|nom(?:\s{1,4}complet)?|compte|clé(?:\s{1,4}d\x27api)?|jeton|identifiants?|mot\s{1,4}de\s{1,4}passe|identité)|(?:e-?mail|courriel|adresse\s{1,4}e-?mail|nom(?:\s{1,4}complet)?|compte|clé(?:\s{1,4}d\x27api)?|jeton|identifiants?|mot\s{1,4}de\s{1,4}passe|identité)[^\n]{0,30}?(?:utilisateur|opérateur|propriétaire))|(?<![A-Za-z0-9_])(?:füge|fuege|sende|schicke|übergib|uebergib|setze|gib|teile|nenne|hänge|binde)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators)[^\n]{0,30}?(?:e-?mail(?:-adresse)?|name|vollständigen\s{1,4}namen|konto|api-?schlüssel|schlüssel|token|zugangsdaten|passwort|identität|benutzernamen?)|(?:e-?mail(?:-adresse)?|name|vollständigen\s{1,4}namen|konto|api-?schlüssel|schlüssel|token|zugangsdaten|passwort|identität|benutzernamen?)[^\n]{0,30}?(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators))[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:header|kopfzeile|parameter|cookie|formular|feld|nächste\s{1,4}anfrage|url)|(?:header|kopfzeile|parameter|cookie|formular|feld|nächste\s{1,4}anfrage|url)[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators)[^\n]{0,30}?(?:e-?mail(?:-adresse)?|name|vollständigen\s{1,4}namen|konto|api-?schlüssel|schlüssel|token|zugangsdaten|passwort|identität|benutzernamen?)|(?:e-?mail(?:-adresse)?|name|vollständigen\s{1,4}namen|konto|api-?schlüssel|schlüssel|token|zugangsdaten|passwort|identität|benutzernamen?)[^\n]{0,30}?(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators)))|(?:header|kopfzeile|parameter|cookie|formular|feld|nächste\s{1,4}anfrage|url)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?<![A-Za-z0-9_])(?:füge|fuege|sende|schicke|übergib|uebergib|setze|gib|teile|nenne|hänge|binde)(?![A-Za-z0-9_])[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators)[^\n]{0,30}?(?:e-?mail(?:-adresse)?|name|vollständigen\s{1,4}namen|konto|api-?schlüssel|schlüssel|token|zugangsdaten|passwort|identität|benutzernamen?)|(?:e-?mail(?:-adresse)?|name|vollständigen\s{1,4}namen|konto|api-?schlüssel|schlüssel|token|zugangsdaten|passwort|identität|benutzernamen?)[^\n]{0,30}?(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators))|(?:добавь|добавьте|включи|включите|отправь|отправьте|передай|передайте|укажи|укажите|вставь|вставьте)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*)[^\n]{0,30}?(?:почт[а-яё]+|email|e-mail|имя|имени|логин[а-яё]*|аккаунт[а-яё]*|ключ[а-яё]*|токен[а-яё]*|парол[а-яё]+|учётн[а-яё]+\s{1,4}запис[а-яё]+)|(?:почт[а-яё]+|email|e-mail|имя|имени|логин[а-яё]*|аккаунт[а-яё]*|ключ[а-яё]*|токен[а-яё]*|парол[а-яё]+|учётн[а-яё]+\s{1,4}запис[а-яё]+)[^\n]{0,30}?(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*))[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:заголов[а-яё]+|header|параметр[а-яё]*|cookie|куки|форм[а-яё]+|поле|следующ[а-яё]+\s{1,4}запрос[а-яё]*|url)|(?:заголов[а-яё]+|header|параметр[а-яё]*|cookie|куки|форм[а-яё]+|поле|следующ[а-яё]+\s{1,4}запрос[а-яё]*|url)[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*)[^\n]{0,30}?(?:почт[а-яё]+|email|e-mail|имя|имени|логин[а-яё]*|аккаунт[а-яё]*|ключ[а-яё]*|токен[а-яё]*|парол[а-яё]+|учётн[а-яё]+\s{1,4}запис[а-яё]+)|(?:почт[а-яё]+|email|e-mail|имя|имени|логин[а-яё]*|аккаунт[а-яё]*|ключ[а-яё]*|токен[а-яё]*|парол[а-яё]+|учётн[а-яё]+\s{1,4}запис[а-яё]+)[^\n]{0,30}?(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*)))|(?:заголов[а-яё]+|header|параметр[а-яё]*|cookie|куки|форм[а-яё]+|поле|следующ[а-яё]+\s{1,4}запрос[а-яё]*|url)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:добавь|добавьте|включи|включите|отправь|отправьте|передай|передайте|укажи|укажите|вставь|вставьте)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*)[^\n]{0,30}?(?:почт[а-яё]+|email|e-mail|имя|имени|логин[а-яё]*|аккаунт[а-яё]*|ключ[а-яё]*|токен[а-яё]*|парол[а-яё]+|учётн[а-яё]+\s{1,4}запис[а-яё]+)|(?:почт[а-яё]+|email|e-mail|имя|имени|логин[а-яё]*|аккаунт[а-яё]*|ключ[а-яё]*|токен[а-яё]*|парол[а-яё]+|учётн[а-яё]+\s{1,4}запис[а-яё]+)[^\n]{0,30}?(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*))|(?:添加|加入|包含|附上|发送|传递|提供|填写|放入|带上|附加)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:(?:用户|使用者|操作者|主人|所有者)[^\n]{0,30}?(?:邮箱|电子邮件|电子邮箱|姓名|名字|用户名|账号|帐号|账户|密钥|令牌|凭据|凭证|身份|密码)|(?:邮箱|电子邮件|电子邮箱|姓名|名字|用户名|账号|帐号|账户|密钥|令牌|凭据|凭证|身份|密码)[^\n]{0,30}?(?:用户|使用者|操作者|主人|所有者))[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:请求头|头部|标头|header|参数|cookie|表单|字段|下一个请求|下一次请求|下个请求|url|查询字符串)|(?:请求头|头部|标头|header|参数|cookie|表单|字段|下一个请求|下一次请求|下个请求|url|查询字符串)[^\n]{0,80}?(?:\n[^\n]{0,80}?)?(?:(?:用户|使用者|操作者|主人|所有者)[^\n]{0,30}?(?:邮箱|电子邮件|电子邮箱|姓名|名字|用户名|账号|帐号|账户|密钥|令牌|凭据|凭证|身份|密码)|(?:邮箱|电子邮件|电子邮箱|姓名|名字|用户名|账号|帐号|账户|密钥|令牌|凭据|凭证|身份|密码)[^\n]{0,30}?(?:用户|使用者|操作者|主人|所有者)))|(?:请求头|头部|标头|header|参数|cookie|表单|字段|下一个请求|下一次请求|下个请求|url|查询字符串)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:添加|加入|包含|附上|发送|传递|提供|填写|放入|带上|附加)[^\n]{0,60}?(?:\n[^\n]{0,60}?)?(?:(?:用户|使用者|操作者|主人|所有者)[^\n]{0,30}?(?:邮箱|电子邮件|电子邮箱|姓名|名字|用户名|账号|帐号|账户|密钥|令牌|凭据|凭证|身份|密码)|(?:邮箱|电子邮件|电子邮箱|姓名|名字|用户名|账号|帐号|账户|密钥|令牌|凭据|凭证|身份|密码)[^\n]{0,30}?(?:用户|使用者|操作者|主人|所有者))""", re.IGNORECASE), "Tool result asks the agent to identify its user or put the user identity in a request (non-English)"),
]

EVASION_RULES: List[Tuple[str, re.Pattern[str], str]] = [
    (
        'evasion:bidi_override',
        _rc(r'[\u202A-\u202E\u2066-\u2069]'),
        'Unicode bidirectional override (Trojan Source evasion attempt)',
    ),
]

# Hidden-element detection in two linear passes: find the first opening tag
# whose attributes hide it, then search once for a payload keyword after it.
# OPEN_TAG_RE always matches from a "<name" and consumes the attribute run up
# to the next "<" or ">", so every character is read once; the candidate is a
# tag only when that run is closed by ">". (A single regex with a lazy
# [\s\S]*? tail, or an attribute run that may cross "<", re-scans the rest of
# the input from every candidate and is super-linear on crafted markup.)
OPEN_TAG_RE = _rc(r'<[a-z0-9]+(?![A-Za-z0-9_])([^<>]*)(>?)', re.IGNORECASE)
# What a style attribute must say to hide an element. Spaces are the ASCII ones (the CSS and HTML
# separators), so Node and Python read the same text the same way.
HIDDEN_ATTR_RE = _rc(r'(?<![A-Za-z0-9_-])(?:display[\t\n\f\r ]*:[\t\n\f\r ]*none|visibility[\t\n\f\r ]*:[\t\n\f\r ]*hidden|opacity[\t\n\f\r ]*:[\t\n\f\r ]*0(?:\.0+)?(?![0-9.])|font-size[\t\n\f\r ]*:[\t\n\f\r ]*0(?:px)?(?![0-9.])|color[\t\n\f\r ]*:[\t\n\f\r ]*transparent|text-indent[\t\n\f\r ]*:[\t\n\f\r ]*-[0-9]{3,}px)', re.IGNORECASE)
# An element of at most 1px, or with a clip that leaves nothing visible, or with no height and
# its overflow cut off, is hidden in the way screen-reader-only text is.
TINY_WIDTH_CSS_RE = _rc(r'(?<![A-Za-z0-9_-])(?:max-)?width[\t\n\f\r ]*:[\t\n\f\r ]*(?:0(?:\.0+)?(?:[a-z]+|%)?(?![0-9.])|(?:0(?:\.[0-9]+)?|1(?:\.0+)?)(?:px)?(?![0-9.a-z%]))', re.IGNORECASE)
TINY_HEIGHT_CSS_RE = _rc(r'(?<![A-Za-z0-9_-])(?:max-)?height[\t\n\f\r ]*:[\t\n\f\r ]*(?:0(?:\.0+)?(?:[a-z]+|%)?(?![0-9.])|(?:0(?:\.[0-9]+)?|1(?:\.0+)?)(?:px)?(?![0-9.a-z%]))', re.IGNORECASE)
OVERFLOW_HIDDEN_CSS_RE = _rc(r'(?<![A-Za-z0-9_-])overflow(?:-[xy])?[\t\n\f\r ]*:[\t\n\f\r ]*hidden(?![A-Za-z0-9_-])', re.IGNORECASE)
CLIP_CSS_RE = _rc(r'(?<![A-Za-z0-9_-])(?:clip[\t\n\f\r ]*:[\t\n\f\r ]*rect\([\t\n\f\r ]*(?:0|1px)|clip-path[\t\n\f\r ]*:[\t\n\f\r ]*inset\([\t\n\f\r ]*(?:50|100)%)', re.IGNORECASE)
# One attribute: name, then an optional value (double-quoted, single-quoted
# or bare). An unterminated quote runs to the end of the run, so every
# character is read once.
ATTR_RE = _rc(r'''([^\t\n\f\r "'<>\/=]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"?|'([^']*)'?|([^\t\n\f\r "'<>=`]*)))?''')
# The classes that hide an element in the common frameworks (a token of the class list).
CLASS_HIDDEN_RE = _rc(r'(?:^|[\t\n\f\r ])(?:hidden|visually-hidden|sr-only|d-none|invisible|is-hidden)(?=[\t\n\f\r ]|$)', re.IGNORECASE)
_ASCII_SPACE = '\t\n\f\r '


def _style_hides(v: str) -> bool:
    return bool(HIDDEN_ATTR_RE.search(v) or CLIP_CSS_RE.search(v)
                or (TINY_WIDTH_CSS_RE.search(v) and TINY_HEIGHT_CSS_RE.search(v))
                or (OVERFLOW_HIDDEN_CSS_RE.search(v) and TINY_HEIGHT_CSS_RE.search(v)))


# True when the attributes of an opening tag really hide the element: the
# boolean hidden attribute, aria-hidden="true", a style that hides it, or a class
# that hides it (hidden, sr-only and the like). A name that merely contains the word
# (data-hidden) or a hidden word elsewhere in the tag does not count.
def _attrs_hide(attrs: str) -> bool:
    for m in ATTR_RE.finditer(attrs):
        name = m.group(1).lower()
        value = next((g for g in (m.group(2), m.group(3), m.group(4)) if g is not None), '')
        if name == 'hidden':
            return True
        if name == 'aria-hidden' and value.strip(_ASCII_SPACE).lower() == 'true':
            return True
        if name == 'class' and CLASS_HIDDEN_RE.search(value):
            return True
        if name == 'style' and _style_hides(value):
            return True
    return False
HIDDEN_PAYLOAD_RE = _rc(r'ignore|system|instruction|prompt|bypass|override|exfil|leak', re.IGNORECASE)


# The payload must be in the text of the hidden element itself: its content
# up to the matching close tag (nested tags removed), at most
# HIDDEN_TEXT_CHARS characters after the opening tag. Text after the element
# does not count.
HIDDEN_TEXT_CHARS = 4096
TAG_RE = _rc(r'<(/?)([a-z0-9]+)(?![A-Za-z0-9_])[^<>]*>', re.IGNORECASE)
_TAG_NAME_RE = _rc(r'<([a-z0-9]+)', re.IGNORECASE)


def _hidden_element_text(text: str, start: int, name: str) -> Tuple[str, int]:
    """Returns the element's text and the index where reading stopped."""
    end = min(len(text), start + HIDDEN_TEXT_CHARS)
    depth = 1
    out = []
    pos = start
    for m in TAG_RE.finditer(text, start):
        if m.start() >= end:
            break
        out.append(text[pos:m.start()])
        out.append(' ')
        pos = m.end()
        if m.group(2).lower() == name:
            depth += -1 if m.group(1) else 1
            if depth == 0:
                return ''.join(out), pos
    out.append(text[pos:max(pos, end)])
    return ''.join(out), max(pos, end)


def _test_hidden_tag(text: str) -> bool:
    pos = 0
    while True:
        m = OPEN_TAG_RE.search(text, pos)
        if m is None:
            return False
        pos = m.end()
        if m.group(2) == '>' and _attrs_hide(m.group(1)):
            tag = _TAG_NAME_RE.match(m.group(0))
            if tag is None:
                continue
            name = tag.group(1).lower()
            inner, stop = _hidden_element_text(text, m.end(), name)
            if HIDDEN_PAYLOAD_RE.search(inner):
                return True
            # Hidden elements nested in this one were part of its text: each
            # character is read once.
            pos = max(pos, stop)


# Earlier, broader form: a hidden element followed anywhere later by a
# payload word. Used only for advisories.
def _test_hidden_tag_anywhere(text: str) -> bool:
    for m in OPEN_TAG_RE.finditer(text):
        if m.group(2) == '>' and _attrs_hide(m.group(1)):
            return HIDDEN_PAYLOAD_RE.search(text, m.end()) is not None
    return False


INDIRECT_INJECTION_RULES: List[Tuple[str, re.Pattern[str], str]] = [
    (
        'indirect:html_comment',
        _rc(r'<!--\s*(?:system|instruction|prompt|override|command)\s*:', re.IGNORECASE),
        'Hidden instruction in HTML comment',
    ),
    (
        'indirect:hidden_tag',
        # The pattern is the linear tag scanner; the rule is _test_hidden_tag().
        OPEN_TAG_RE,
        'Hidden DOM element with injection payload',
    ),
]

# Markdown image exfiltration: ![alt](http(s)://host/...?key=value ...).
# MD_IMAGE_RE always matches from "![" and consumes the alt text and the URL
# once, so the scan is linear; the URL is then checked in code. Patterns that
# chain a lazy URL with a "[^)]*\)" tail re-scan the rest of the input from
# every "![" when no ")" follows.
MD_IMAGE_RE = _rc(r'!\[[^\]]*(?:\]\(([^\s)]*))?', re.IGNORECASE)
MD_URL_SCHEME_RE = _rc(r'^https?:\/\/[^?&]', re.IGNORECASE)
MD_URL_SECRET_PARAM_RE = _rc(r'[?&](?:key|token|pass|secret|cred|data|val|leak|exfil)=', re.IGNORECASE)


def _test_markdown_image(text: str) -> bool:
    closing = text.rfind(')')
    if closing == -1:
        return False
    for m in MD_IMAGE_RE.finditer(text):
        url = m.group(1)
        if url and m.end() <= closing and MD_URL_SCHEME_RE.search(url) \
                and MD_URL_SECRET_PARAM_RE.search(url, url.find('//') + 2):
            return True
    return False


# Cheap necessary conditions for the identity-request rules (same as in
# rules.js), checked in front of the two (much more expensive) patterns.
# Every match of pi:identity_request has a word for the user (user, operator,
# owner...) or "who", and a place word (header, cookie, URL parameter, form
# field, next request...) or one of its "who is your user" phrasings; every
# match of pi:identity_request_multi has a word for the user and a place word
# of its language. The groups are copied from the patterns (a test checks
# that), so a text the pattern would match is never skipped.
IDENTITY_PREFILTERS: Dict[str, Tuple[re.Pattern[str], ...]] = {
    'pi:identity_request': (
        _rc(r"""(?:user|operator|owner|human|principal)|customer|account\s{1,4}holder|who|(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))|their\s{1,4}(?:(?:primary|login|account|real)\s{1,4})?e-?mail(?:\s{1,4}address(?:es)?)?""", re.IGNORECASE),
        _rc(r"""(?:(?:http\s{1,4}|request\s{1,4}|custom\s{1,4}|response\s{1,4})?headers?|x-[a-z0-9-]{1,40}|url\s{1,4}param(?:eter)?s?|query\s{1,4}(?:string|param(?:eter)?s?)|\?[a-z_]{1,20}=|cookies?|form\s{1,4}(?:fields?|inputs?|data)|(?:request\s{1,4})?(?:body|payload)|next\s{1,4}(?:request|call|message)|(?:subsequent|following|every|each|outgoing)\s{1,4}(?:http\s{1,4})?(?:requests?|calls?|fetch(?:es)?))|who|your\s{1,4}(?:user|operator|owner|human|principal)|(?:(?:http\s{1,4}|request\s{1,4}|custom\s{1,4}|response\s{1,4})?headers?|(?<![A-Za-z0-9_])x-[a-z0-9-]{1,40}|url\s{1,4}param(?:eter)?s?|query\s{1,4}(?:string|param(?:eter)?s?)|\?[a-z_]{1,20}=|cookies?|form\s{1,4}(?:fields?|inputs?|data)|request\s{1,4}(?:body|payload)|next\s{1,4}(?:request|call|message)|(?:in|into|inside|within|with|to|on)\s{1,4}(?:an?|the|your|every|each|any|all|subsequent|following|outgoing|next)\s{1,4}(?:(?:http|outgoing|network|api|subsequent|following)\s{1,4}){0,2}(?:requests?|calls?))""", re.IGNORECASE),
    ),
    'pi:identity_request_multi': (
        _rc(r"""(?:usuario|operador|due[ñn]o|propietario)|(?:usu[aá]rio|operador|dono|propriet[aá]rio)|(?:utilisateur|opérateur|propriétaire)|(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators)|(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*)|(?:用户|使用者|操作者|主人|所有者)|(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))""", re.IGNORECASE),
        _rc(r"""(?:cabecera|encabezado|header|par[aá]metro|cookie|formulario|campo|(?:siguiente|pr[oó]xima)\s{1,4}(?:petici[oó]n|solicitud)|url)|(?:cabe[cç]alho|header|par[aâ]metro|cookie|formul[aá]rio|campo|pr[oó]xima\s{1,4}requisi[cç][aã]o|url)|(?:en-t[eê]te|header|param[eè]tre|cookie|formulaire|champ|prochaine\s{1,4}requ[eê]te|url)|(?:header|kopfzeile|parameter|cookie|formular|feld|nächste\s{1,4}anfrage|url)|(?:заголов[а-яё]+|header|параметр[а-яё]*|cookie|куки|форм[а-яё]+|поле|следующ[а-яё]+\s{1,4}запрос[а-яё]*|url)|(?:请求头|头部|标头|header|参数|cookie|表单|字段|下一个请求|下一次请求|下个请求|url|查询字符串)""", re.IGNORECASE),
    ),
}
_IDENTITY_PATTERNS: Dict[str, re.Pattern[str]] = {
    rule_id: pat for rule_id, pat, _ in INJECTION_RULES if rule_id in IDENTITY_PREFILTERS
}


def _identity_test(rule_id: str, text: str) -> bool:
    for prefilter in IDENTITY_PREFILTERS[rule_id]:
        if prefilter.search(text) is None:
            return False
    return _IDENTITY_PATTERNS[rule_id].search(text) is not None


# Rules whose match is computed by a function instead of pattern.search().
RULE_TESTERS: Dict[str, Any] = {
    'indirect:hidden_tag': _test_hidden_tag,
    'exfil:markdown_image': _test_markdown_image,
    'pi:multi_ru': _test_multi_ru,
    'pi:multi_zh': _test_multi_zh,
    'pi:identity_request': lambda t: _identity_test('pi:identity_request', t),
    'pi:identity_request_multi': lambda t: _identity_test('pi:identity_request_multi', t),
}

EXFIL_VERB_SOURCE = r'(?<![A-Za-z0-9_])(give|reveal|send|show|print|expose|leak|paste|dump|read|open|cat|fetch|extract|steal)(?![A-Za-z0-9_])'
EXFIL_VERBS = _rc(EXFIL_VERB_SOURCE, re.IGNORECASE)
CRED_OBJECTS = _rc(r"""(?<![A-Za-z0-9_])(passwords?|api[_ -]?keys?|secrets?|credentials?|tokens?|ssh[ _-]?keys?|private[ _-]?keys?|aws_secret[a-z0-9_]*|aws_access[a-z0-9_]*)(?![A-Za-z0-9_])|(?:^|\s|['"`])\.env(?:\.[a-z0-9]+)?(?![A-Za-z0-9_])""", re.IGNORECASE)

# The verb must start a clause (an instruction, not a description such as
# "this library reads tokens from ...") or be followed by "me"/"us", and the
# credential must follow it in the same clause, within EXFIL_CLAUSE_CHARS
# characters. No MULTILINE flag: line starts are matched by the newline
# itself, so a run of blank lines is read once.
EXFIL_CLAUSE_CHARS = 80
EXFIL_CLAUSE_PREFIX = r"""(?:^|[.!?;:\r\n\u2028\u2029])[ \t]*(?:[\"'`(\[*-][ \t]*)?|(?<![A-Za-z0-9_])(?:please|now|then|and|also|just|first|immediately|go\s+ahead\s+and|(?:can|could|would|will)\s+you|(?:want|need|ask)\s+you\s+to|you\s+(?:must|should|will|need\s+to|have\s+to))\s+"""
EXFIL_CLAUSE_RE = _rc(
    r'(?:(?:' + EXFIL_CLAUSE_PREFIX + r')' + EXFIL_VERB_SOURCE + r'|' + EXFIL_VERB_SOURCE + r'(?=\s+(?:me|us)(?![A-Za-z0-9_])))'
    + r'[^.!?;\r\n]{0,' + str(EXFIL_CLAUSE_CHARS) + r'}?(?:' + CRED_OBJECTS.pattern + r')',
    re.IGNORECASE,
)

# Advisory tier: the broader forms of four rules. They match much benign
# text (documentation, code, role-play requests), so a match does not block:
# the verdict stays "allow" and the result carries `advisory` with the rule.
# A blocking rule always wins over an advisory.
_ADVISORY_ACT_AS = _rc(r'act\s+as\s+(?:if|a)', re.IGNORECASE)
_ADVISORY_FORGET = _rc(r'forget\s+(?:about\s+)?(?:everything|all|your)', re.IGNORECASE)

ADVISORY_RULES: List[Tuple[str, Any, str]] = [
    ('exfil:credentials', lambda t: EXFIL_VERBS.search(t) is not None and CRED_OBJECTS.search(t) is not None, 'Mentions reading or sending credentials'),
    ('pi:act_as', lambda t: _ADVISORY_ACT_AS.search(t), 'Role-play request (act as)'),
    ('pi:forget', lambda t: _ADVISORY_FORGET.search(t), 'Asks to forget context'),
    ('indirect:hidden_tag', _test_hidden_tag_anywhere, 'Hidden element in markup followed by instruction-like words'),
]

SENSITIVE_PATH_RULES: List[Tuple[str, re.Pattern[str], str]] = [
    (
        'path:sensitive_file',
        _rc(r"""(?:^|[\s"'`(\[@])(?:~|\/home\/[^\t\n\f\r \/]+|\/root|[A-Za-z]:[\/\\]Users[\/\\][^\t\n\f\r \/\\"']+(?: [^\t\n\f\r \/\\"']+)*|%(?:USERPROFILE|HOMEPATH)%|\$env:(?:USERPROFILE|HOME)(?![A-Za-z0-9_])|\$\{?(?:HOME|USERPROFILE)\}?)?[\/\\]?\.(?:ssh[\/\\](?:id_rsa|id_ed25519|authorized_keys)|aws[\/\\]credentials|env(?:\.[a-z0-9]+)?)(?![A-Za-z0-9_])|=(?:~|\/home\/[^\t\n\f\r \/]+|\/root|[A-Za-z]:[\/\\]Users[\/\\][^\t\n\f\r \/\\"']+(?: [^\t\n\f\r \/\\"']+)*|%(?:USERPROFILE|HOMEPATH)%|\$env:(?:USERPROFILE|HOME)(?![A-Za-z0-9_])|\$\{?(?:HOME|USERPROFILE)\}?)[\/\\]?\.(?:ssh[\/\\](?:id_rsa|id_ed25519|authorized_keys)|aws[\/\\]credentials|env(?:\.[a-z0-9]+)?)(?![A-Za-z0-9_])|\/etc\/(?:shadow|passwd)(?![A-Za-z0-9_])""", re.IGNORECASE),
        'Targeting sensitive system credentials or environment file',
    ),
]

MARKDOWN_EXFIL_RULES: List[Tuple[str, re.Pattern[str], str]] = [
    (
        'exfil:markdown_image',
        # The pattern is the linear image scanner; the rule is _test_markdown_image().
        MD_IMAGE_RE,
        'Covert exfiltration via markdown image URL parameter',
    ),
]

# evaluate() scans an input longer than MAX_SCAN_CHARS whole, in overlapping
# windows (_evaluate_oversize() below), and blocks one longer than
# MAX_TOOL_RESULT_SCAN_CHARS (rule size:oversize), so no part of an input is left
# unscanned. Tool results go through scan_windows(), which allows output past
# that limit and only marks it truncated=True. Lengths count code points here and
# UTF-16 code units in Node.js; the two only differ for characters outside the BMP.
MAX_SCAN_CHARS = 256 * 1024

@dataclass
class Assessment:
    verdict: str  # 'allow' | 'block'
    confidence: float
    rule: str
    reason: Optional[str]
    engine: str = 'oss-local'
    rules_version: str = RULES_VERSION
    truncated: bool = False
    advisory: Optional[Dict[str, str]] = None

    @property
    def allowed(self) -> bool:
        return self.verdict == 'allow'

    def to_dict(self) -> Dict[str, Any]:
        d = {
            'verdict': self.verdict,
            'confidence': self.confidence,
            'rule': self.rule,
            'reason': self.reason,
            'engine': self.engine,
            'rules_version': self.rules_version,
            'allowed': self.allowed,
        }
        if self.truncated:
            d['truncated'] = True
        if self.advisory:
            d['advisory'] = dict(self.advisory)
        return d

def _strip_c_comments(text: str) -> str:
    """Remove /* ... */ comments in one pass. An unterminated "/*" ends the
    search: no later comment can be closed either."""
    start = text.find('/*')
    if start == -1:
        return text
    parts = []
    pos = 0
    while start != -1:
        end = text.find('*/', start + 2)
        if end == -1:
            break
        parts.append(text[pos:start])
        pos = end + 2
        start = text.find('/*', pos)
    parts.append(text[pos:])
    return ''.join(parts)


def _join_line_break(m: 're.Match[str]') -> str:
    run = m.group(0)
    if '\n' not in run and '\r' not in run:
        return run
    whole = m.string
    start, end = m.start(), m.end()
    if start > 0 and end < len(whole):
        left, right = whole[start - 1], whole[end]
        if (left.isalnum() or left in _JOIN_EXTRA_LEFT) and (right.isalnum() or right in _JOIN_EXTRA_RIGHT):
            return ''
    return run


def _space_invisible(text: str) -> str:
    """The text with every invisible character replaced by one space (one per code point, so an index in the
    result is the same index in `text`). The view that catches an invisible character used as a space between
    two words (see spaceInvisible in lib/invisible.js)."""
    return INVISIBLE_ASTRAL_RE.sub(' ', ZERO_WIDTH_RE.sub(' ', text))


# (text, its spaced view) as ONE tuple, replaced in a single assignment: a thread that reads it always gets a
# text together with its own view, whatever other threads are doing.
_SPACED_MEMO: Tuple[Optional[str], str] = (None, '')


def _spaced_view(text: str) -> str:
    """_space_invisible of the last text a rule was run on, so the many rules of one text build it once."""
    global _SPACED_MEMO
    memo = _SPACED_MEMO
    if memo[0] is text:
        return memo[1]
    view = _space_invisible(text)
    _SPACED_MEMO = (text, view)
    return view


def _strip_invisible(text: str) -> str:
    """Removes invisible characters (zero-width, variation selectors, tag characters)."""
    return INVISIBLE_ASTRAL_RE.sub('', ZERO_WIDTH_RE.sub('', text))


def invisible_view(text: str) -> Optional[Tuple[str, 'array[int]']]:
    """Text without invisible characters and the index map back to `text`
    (map[i] is the index of clean[i]; map[len(clean)] is len(text)). None when
    the text has no invisible character. See invisibleView in rules.js."""
    runs = [m.span() for m in ZERO_WIDTH_RE.finditer(text)] + [m.span() for m in INVISIBLE_ASTRAL_RE.finditer(text)]
    if len(text) <= MAX_WRAP_VIEW_CHARS and '\n' in text:
        runs += [m.span() for m in WRAP_BREAK_RE.finditer(text)]
    if not runs:
        return None
    runs.sort(key=lambda r: (r[0], -r[1]))
    mapping = array('q')
    parts: List[str] = []
    pos = 0
    for start, end in runs:
        if end <= pos:
            continue
        mapping.extend(range(pos, max(pos, start)))
        parts.append(text[pos:max(pos, start)])
        pos = max(pos, end)
    mapping.extend(range(pos, len(text)))
    parts.append(text[pos:])
    mapping.append(len(text))
    return ''.join(parts), mapping


def _clean_value(text: str) -> str:
    """A value as the secret rules see it: no invisible characters and no wrap breaks."""
    s = _strip_invisible(text)
    return WRAP_BREAK_RE.sub('', s) if '\n' in s else s


def normalize_input(text: str) -> Tuple[str, str]:
    if not isinstance(text, str):
        return '', ''
    # 1. Strip invisible evasion characters (zero-width, variation selectors, tag characters)
    stripped = _strip_invisible(text)
    # 1b. Strip ANSI escape sequences
    stripped = ANSI_ESCAPE_RE.sub('', stripped)
    # 2. Strip inline C-style comments (e.g. sys/*safe*/tem -> system)
    stripped = _strip_c_comments(stripped)
    # 3. Compatibility folding for matching (NFKC): fullwidth Latin becomes ASCII.
    if NON_ASCII_RE.search(stripped):
        stripped = stripped.translate(_COMPAT_FOLD_TABLE)
    # 4. Rejoin words and tokens split across newlines (sys\ntem -> system).
    #    Linear: only the character on each side of a newline run is inspected.
    if '\n' in stripped or '\r' in stripped:
        stripped = WHITESPACE_RUN_RE.sub(_join_line_break, stripped)
    # 5. Normalize homoglyphs (Cyrillic to Latin for English hijack detection)
    normalized = stripped.translate(_HOMOGLYPH_TABLE)
    return normalized, stripped


# Default policy by tiers (same list as ADVISORY_BY_DEFAULT in rules.js). A
# match of these heuristic rules is an advisory unless strict mode is on
_ENV_FLAG_WARNED: Set[Tuple[str, str]] = set()


def env_flag(name: str) -> bool:
    """True when the hardening flag `name` (ZN_STRICT, ZN_BLOCK_TRUNCATED, ZN_ALLOW_TRUNCATED) is set to "1", the only value that turns it
    on. Any other value (true, yes, on...) leaves it off, so it is said once in the log rather than ignored silently."""
    value = os.environ.get(name)
    if value == "1":
        return True
    if value not in (None, "", "0") and (name, value) not in _ENV_FLAG_WARNED:
        _ENV_FLAG_WARNED.add((name, value))
        import logging
        logging.getLogger("zn_gate").warning(
            "zn_gate: %s is set to %r, but only %s=1 turns it on, so it is off "
            "(accepted values: 1 to turn it on; unset, empty or 0 to leave it off)", name, value[:20], name)
    return False


# (strict=True, or ZN_STRICT=1 in the environment).
ADVISORY_BY_DEFAULT = frozenset([
    'pi:identity_override',
    'pi:system_tag',
    'pi:system_bracket',
    'pi:new_instructions',
    'pi:pretend',
    'pi:roleplay',
    'pi:jailbreak',
    'pi:bypass',
    'pi:override',
    'pi:template_boundary',
    'pi:identity_request',
    'pi:identity_request_multi',
])


def _strict(strict: Optional[bool]) -> bool:
    # The environment can only harden: strict=False does not lift ZN_STRICT=1 (as in Node.js).
    return bool(strict) or env_flag('ZN_STRICT')


def _b64_decode_lenient(data: str) -> bytes:
    """Decode Base64 the way Node.js Buffer.from(data, 'base64') and `base64 -d` do.

    Missing '=' padding is accepted, decoding stops at the first '=', and a
    single dangling character at the end (too short for a byte) is dropped,
    so unpadded Base64 cannot slip past the smuggling check.
    """
    body = data.split('=', 1)[0]
    if len(body) % 4 == 1:
        body = body[:-1]
    return base64.b64decode(body + '=' * (-len(body) % 4))


# A run of two or more empty or whitespace-only lines becomes one empty line before any rule runs, so text
# that follows a long padding run is read in the same scan window as the text before it (same class as
# collapseBlankRuns in rules.js; whitespace listed explicitly, not \s, so both packages agree).
_BLANK_RUN_TEST = _rc(r'\n[ \t\r\f\v\u0085\u00a0\u00ad\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]*\n[ \t\r\f\v\u0085\u00a0\u00ad\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]*\n')
_BLANK_SPACE = _rc(r'[ \t\r\f\v\u0085\u00a0\u00ad\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]*')


def _collapse_blank_runs(text: str) -> str:
    if not isinstance(text, str) or not _BLANK_RUN_TEST.search(text):
        return text
    out: List[str] = []
    copied = 0
    i = text.find('\n')
    while i != -1:
        j = i
        blanks = 0
        while True:
            k = text.find('\n', j + 1)
            if k == -1:
                break
            m = _BLANK_SPACE.match(text, j + 1, k)
            if m is None or m.end() != k:
                break
            blanks += 1
            j = k
        if blanks >= 2:
            out.append(text[copied:i])
            out.append('\n\n')
            copied = j + 1
        i = text.find('\n', j + 1)
    out.append(text[copied:])
    return ''.join(out)


def _check_base64_pipes(candidates: Tuple[str, ...], strict: Optional[bool]) -> Tuple[Optional[Assessment], Optional[Dict[str, Any]]]:
    """Base64 payload smuggling: every `echo|printf ... | base64 -d` in `candidates` is
    decoded and evaluated, not only the first, within hard caps that fail closed.
    Returns (a block Assessment or None, advisory)."""
    advisory = None
    payloads = []
    for text_candidate in candidates:
        for b64_match in B64_EXEC_RE.finditer(text_candidate):
            payload = b64_match.group(2) or b64_match.group(4)
            if payload and payload not in payloads:
                payloads.append(payload)
    if len(payloads) > MAX_B64_PAYLOADS:
        return Assessment(
            verdict='block',
            confidence=0.99,
            rule='evasion:base64_smuggling',
            reason=f'Smuggled Base64 execution: more than {MAX_B64_PAYLOADS} Base64 decode pipes in one command'
        ), advisory
    total = 0
    for payload in payloads:
        total += len(payload) * 3 // 4
        if total > MAX_B64_DECODED_BYTES:
            return Assessment(
                verdict='block',
                confidence=0.99,
                rule='evasion:base64_smuggling',
                reason='Smuggled Base64 execution: too much Base64 data to inspect'
            ), advisory
        try:
            decoded = _b64_decode_lenient(payload).decode('utf-8', errors='ignore')
            inner_res = evaluate(decoded, strict=strict)
            if inner_res.advisory and advisory is None:
                advisory = dict(inner_res.advisory)
            if not inner_res.allowed:
                return Assessment(
                    verdict='block',
                    confidence=inner_res.confidence,
                    rule='evasion:base64_smuggling',
                    reason=f'Smuggled Base64 execution: {inner_res.reason or inner_res.rule}'
                ), advisory
        except Exception:
            pass
    return None, advisory


def _evaluate_oversize(input_text: str, strict: bool) -> Assessment:
    # Scanned whole, in overlapping windows; one past MAX_TOOL_RESULT_SCAN_CHARS is
    # blocked, because the part beyond the limit would go unscanned.
    if len(input_text) > MAX_TOOL_RESULT_SCAN_CHARS:
        return Assessment(verdict='block', confidence=1.0, rule='size:oversize',
                          reason='Input too large to scan in full', truncated=True)
    # A Base64 pipe longer than the window overlap can straddle two windows and be cut in
    # both: the pipes are found in the whole input first. The windows still check normalized text.
    b64_block, _ = _check_base64_pipes((input_text,), strict)
    if b64_block is not None:
        return b64_block
    return scan_windows(input_text, strict=strict)


def _evaluate_uncached(input_text: str, strict: bool = False) -> Assessment:
    if not isinstance(input_text, str) or not input_text.strip():
        return Assessment(verdict='allow', confidence=1.0, rule='none', reason=None)
    # Invisible padding is judged on the input as received (see evaluateUncached in rules.js).
    if len(input_text) > MAX_SCAN_CHARS and too_invisible([input_text]):
        return invisible_block()
    input_text = _collapse_blank_runs(input_text)
    if len(input_text) > MAX_SCAN_CHARS:
        return _evaluate_oversize(input_text, strict)

    normalized, stripped = normalize_input(input_text)
    # The raw input is matched with the same characters as in Node.js (see _CASE_FOLD_GUARD).
    raw = input_text.translate(_CASE_FOLD_GUARD)

    tier_advisory = None

    b64_block, b64_advisory = _check_base64_pipes((normalized, stripped), strict)
    if b64_block is not None:
        return b64_block

    target_list = [normalized, stripped, raw]
    # An invisible character used as a space joins the words in the stripped views, so the same passes also
    # run with each invisible character replaced by a space (see evaluateUncached in rules.js).
    spaced_input = _space_invisible(input_text)
    if spaced_input != input_text:
        spaced_normalized, spaced_stripped = normalize_input(spaced_input)
        target_list += [spaced_normalized, spaced_stripped, spaced_input.translate(_CASE_FOLD_GUARD)]
    targets = list(dict.fromkeys(target_list))

    for text in targets:
        # 0. Evasion Rules (BiDi Trojan Source)
        for rule_id, pat, desc in EVASION_RULES:
            if pat.search(text):
                return Assessment(verdict='block', confidence=0.99, rule=rule_id, reason=desc)

        # 1. Covert Markdown Image Exfiltration
        for rule_id, pat, desc in MARKDOWN_EXFIL_RULES:
            tester = RULE_TESTERS.get(rule_id)
            if tester(text) if tester else pat.search(text):
                return Assessment(verdict='block', confidence=0.98, rule=rule_id, reason=desc)

        # 2. Sensitive Path Traversal
        for rule_id, pat, desc in SENSITIVE_PATH_RULES:
            if pat.search(text):
                return Assessment(verdict='block', confidence=0.92, rule=rule_id, reason=desc)

        # 3. Indirect Injections (HTML comments & hidden tags)
        for rule_id, pat, desc in INDIRECT_INJECTION_RULES:
            tester = RULE_TESTERS.get(rule_id)
            if tester(text) if tester else pat.search(text):
                return Assessment(verdict='block', confidence=0.95, rule=rule_id, reason=desc)

        # 4. Standard Prompt Injections
        for rule_id, pat, desc in INJECTION_RULES:
            tester = RULE_TESTERS.get(rule_id)
            if tester(text) if tester else pat.search(text):
                if not strict and rule_id in ADVISORY_BY_DEFAULT:
                    if tier_advisory is None:
                        tier_advisory = {'rule': rule_id, 'reason': desc}
                    continue
                return Assessment(verdict='block', confidence=0.95, rule=rule_id, reason=desc)

        # 5. Exfiltration Compound (verb + credentials)
        if EXFIL_VERBS.search(text) and CRED_OBJECTS.search(text) and EXFIL_CLAUSE_RE.search(text):
            return Assessment(
                verdict='block',
                confidence=0.90,
                rule='exfil:credentials',
                reason='Imperative verb requesting credentials/secrets'
            )

    if tier_advisory:
        return Assessment(verdict='allow', confidence=0.99, rule='none', reason=None, advisory=tier_advisory)

    for text in targets:
        for rule_id, test, desc in ADVISORY_RULES:
            if test(text):
                return Assessment(verdict='allow', confidence=0.99, rule='none', reason=None,
                                  advisory={'rule': rule_id, 'reason': desc})

    if b64_advisory:
        return Assessment(verdict='allow', confidence=0.99, rule='none', reason=None, advisory=b64_advisory)

    return Assessment(verdict='allow', confidence=0.99, rule='none', reason=None)


# -------------------------------------------------------------------------
# DLP & Secret Masking Rules
# -------------------------------------------------------------------------
SECRET_PATTERNS: List[Tuple[str, re.Pattern[str], str]] = [
    # A body may not contain another BEGIN header: linear on repeated headers without END.
    ("secret:private_key", _rc(r"""-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----"""), "[REDACTED_PRIVATE_KEY]"),
    ("secret:anthropic_key", _rc(r'(?<![A-Za-z0-9_])(sk-ant-[A-Za-z0-9_-]{30,})(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))'), "[REDACTED_ANTHROPIC_KEY]"),
    # A key without a known prefix ends at the first character that is not a letter or digit.
    ("secret:openai_key", _rc(r"""(?<![A-Za-z0-9_])(sk-(?:(?:proj|svcacct|admin|[Nn]one|or-v1|lf)-[A-Za-z0-9_-]{28,}(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))|helicone-(?:(?:eu|cp|gov|rl)-){0,4}[a-z0-9]{7}(?:-[a-z0-9]{7}){3}(?![a-z0-9])|(?=(?:eu|cp|gov|rl)-|[a-z0-9]{7}-)(?=[a-z-]{0,46}[0-9])(?:(?:eu|cp|gov|rl)-){0,4}[a-z0-9]{7}(?:-[a-z0-9]{7}){3}(?![a-z0-9])(?!-[a-z0-9])|sp-[A-Za-z0-9]{28,}(?![A-Za-z0-9])|[A-Za-z0-9]{28,}(?![A-Za-z0-9])|(?:(?!sk-)[A-Za-z0-9_-]){1,200}?T3BlbkFJ[A-Za-z0-9_-]{20,}(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))))"""), "[REDACTED_OPENAI_KEY]"),
    ("secret:aws_access_key", _rc(r'(?<![A-Za-z0-9_])(AKIA[0-9A-Z]{16})(?![A-Za-z0-9_])'), "[REDACTED_AWS_KEY]"),
    ("secret:aws_secret_key", _rc(r"""((?:[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy]|[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Ww][Ss]_[Kk][Ee][Yy])\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})(['"]?)"""), r'\1[REDACTED_AWS_SECRET]\3'),
    ("secret:github_token", _rc(r'(?<![A-Za-z0-9_])((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,40}|github_pat_[A-Za-z0-9_]{82})(?![A-Za-z0-9_])'), "[REDACTED_GITHUB_TOKEN]"),
    ("secret:db_url_password", _rc(r'((?:[Pp][Oo][Ss][Tt][Gg][Rr][Ee][Ss](?:[Qq][Ll])?|[Mm][Yy][Ss][Qq][Ll]|[Mm][Oo][Nn][Gg][Oo][Dd][Bb](?:\+[Ss][Rr][Vv])?|[Rr][Ee][Dd][Ii][Ss]|[Aa][Mm][Qq][Pp])(?:\+[A-Za-z0-9_]+)?:\/\/[^:\s\/]+:)(?!(?:\$\{(?:[A-Z_][A-Z0-9_]*|[a-z_][a-z0-9_]*)\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|<[A-Za-z][A-Za-z_-]{0,63}>|\{\{\s*[A-Za-z_][A-Za-z_.]*\s*\}\})@)([^@\s\/]+)(@)'), r'\1[REDACTED_DB_PASSWORD]\3'),
    # The lookahead + backreference pairs act as atomic groups, so a long run of
    # "-eyJ" cannot make the engine retry every split point, and the lookbehind
    # allows a single start per token. Only used when the
    # text contains ".eyJ" (see SECRET_PATTERN_REQUIRES).
    ("secret:jwt_token", _rc(r'(?<![A-Za-z0-9_-])(eyJ(?=([A-Za-z0-9_-]{10,512}))\2\.eyJ(?=([A-Za-z0-9_=-]{10,8192}))\3\.[A-Za-z0-9_.+/=-]{10,4096})(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))'), "[REDACTED_JWT]"),
    # Credential assignments. A name right after "${" is a shell reference, and
    # after "$" (PHP, PowerShell, Perl) only "=" assigns: "$NAME:" is a reference
    # followed by text. The value (group 2) is checked with _is_non_secret_value.
    ("secret:env_credential", _rc(r"""(?=[A-Za-z0-9_])(?<![A-Za-z0-9_])(?<!\$\{)(?:(?<!\$)|(?=[A-Za-z0-9_]+\s*=))((?:[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]_[Kk][Ee][Yy]|[Aa][Pp][Ii]_[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh]_[Tt][Oo][Kk][Ee][Nn]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee]_[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]_[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd])["']?\s*[:=]\s*['"]?)([^\s'"]{12,})(['"]?)"""), r'\1[REDACTED_SECRET]\3'),
    # Environment-style names with a prefix: OPENAI_API_KEY=, "DB_PASSWORD": "...",
    # `ENV X_TOKEN value` in a Dockerfile, $X_SECRET = '...' in PHP. Upper case
    # only, so code such as `token = response.json()` is left alone.
    ("secret:prefixed_credential", _rc(r"""(?=[A-Z0-9])(?<![A-Za-z0-9_])(?<!\$\{)(?:(?<!\$)|(?=[A-Za-z0-9_]+[ \t]*=))((?:ENV[ \t]+(?:[A-Z0-9]+_)+(?:API_KEY|APIKEY|SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIALS|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD)[ \t]+|(?:[A-Z0-9]+_)+(?:API_KEY|APIKEY|SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIALS|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD)["']?[ \t]*[:=][ \t]*)['"]?)([^\s'"]{12,})(['"]?)"""), r'\1[REDACTED_SECRET]\3'),
    # The default of a shell or Compose reference, ${DB_PASSWORD:-<value>}: only
    # redacted when it looks machine-generated (most defaults are for development).
    ("secret:credential_default", _rc(r"""(\$\{(?:[A-Z0-9]+_)*(?:API_KEY|APIKEY|SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIALS|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD):?[-=])([^\s'"{}$]{12,})(\})"""), r'\1[REDACTED_SECRET]\3'),
]

# Substrings a text must contain before the pattern is run at all.
SECRET_PATTERN_REQUIRES: Dict[str, str] = {
    "secret:jwt_token": ".eyJ",
    "secret:credential_default": "${",
}

# A text without a match for one of these cannot match the credential patterns,
# which are then not run at all.
SECRET_PATTERN_PREFILTERS: Dict[str, re.Pattern[str]] = {
    "secret:env_credential": _rc(r"""_[Kk][Ee][Yy]|_[Tt][Oo][Kk][Ee][Nn]|_[Pp][Aa][Ss][Ss]"""),
    "secret:prefixed_credential": _rc(r"""KEY|TOKEN|SECRET|PASS|PWD|CREDENTIALS"""),
}

# ---------------------------------------------------------------------------
# Values of credential assignments that are not secrets. Same as
# isNonSecretValue in packages/zn-gate/lib/rules.js (see the comment there for
# the order of the checks). Lengths are counted in UTF-16 units, as in Node.js.
# ---------------------------------------------------------------------------
MAX_FILTERED_VALUE = 512
# Characters of values checked per redact_secrets call (UTF-16 units). Past
# that, credential matches are redacted without the checks, which bounds
# their cost on crafted input.
MAX_FILTERED_CHARS = 32 * 1024
CREDENTIAL_URL_RE = _rc(r"""^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\/@:\s]*:([^\/@\s]*)@)?""")
CREDENTIAL_STORE_RE = _rc(r"""^(?:arn:|vault:|secretref:|@Microsoft\.KeyVault\(|projects\/[^\/]+\/secrets\/)""")
CREDENTIAL_CODE_ROOT_RE = _rc(r"""^(?:process\.env[.\[]|import\.meta\.env[.\[]|os\.environ|os\.getenv\(|getenv\(|settings\.|config\.|secrets\.|std::env::|env::var|ENV(?:\[|\.fetch\()|\$ENV\{|System\.getenv\(|Deno\.env\.|Bun\.env\.|\[Environment\]::|\([A-Z][a-z]+-[A-Z])""")
CREDENTIAL_PLACEHOLDER_RE = _rc(r"""^(?:%\([A-Za-z_]*\)s|<[^<>]*>|\{\{[^{}]*\}\}|\$\{[^{}]*\}|#\{[^{}]*\}|\*+|!(?:Ref|Sub|GetAtt|ImportValue|Join|Select|Split|FindInMap|If|Base64|Cidr|GetAZs|Equals|And|Or|Not|Condition|Transform)|([A-Za-z0-9])(?:\1|[-_.:])*)$""")
CREDENTIAL_REFERENCE_NAME_RE = _rc(r"""^(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9_.-]*|[A-Za-z][a-z]+(?:[A-Z][a-z]+)*[0-9]*)$""")
CREDENTIAL_REFERENCE_RE = _rc(r"""^(?:\$\$?([A-Za-z_][A-Za-z0-9_]*)|\$env:([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%|@([A-Za-z0-9_.-]+)@|\[([^\[\]]*)\])$""")
CREDENTIAL_PLACEHOLDER_MARK_RE = _rc(r"""<[^<>]*>|^[<{\[]|^\$\(|^(?:0123456789|1234567890|[Aa][Bb][Cc][Dd][Ee][Ff]|[Qq][Ww][Ee][Rr][Tt][Yy])|([A-Za-z0-9])\1{7,}""")
CREDENTIAL_PLACEHOLDER_MARKS = ('xxxx', '***', '...', '${', '#{', '{{', 'deadbeef')
# re.ASCII keeps case folding to ASCII letters, as in JavaScript.
CREDENTIAL_PLACEHOLDER_WORDS = _rc(r"""(?<![A-Za-z])(?:password|passwd|passw0rd|secret|changeme|change_me|example|placeholder|your[_-]?|redacted|dummy|sample|foobar|hunter2|todo|insert|replace|mypass|pass(?:word)?123|fake|mock|tests?|testing|demo|stub|fixme|not[_-]?set|unset|set[_-]me|change[_-]this)(?![A-Za-z])""", re.IGNORECASE | re.ASCII)
# The same pattern without IGNORECASE, applied to the value with ASCII letters
# lower-cased: same result, several times faster in Python's re.
_PLACEHOLDER_WORDS_LOWER = _rc(CREDENTIAL_PLACEHOLDER_WORDS.pattern)
_ASCII_LOWER = str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
CREDENTIAL_CODE_RE = _rc(r"""^[(!&*@:]*([A-Za-z_$][A-Za-z0-9_$]*(?:(?:\?\.|\.|::|->)[A-Za-z_$][A-Za-z0-9_$]*)*)(?:((?:->[(\[{]|!?[(\[])(?:[A-Za-z0-9_$.:=(\[{!?&|,]|[)\]}](?![A-Za-z0-9_$]))*)|!|[)\]]*)$""")
CREDENTIAL_DOTTED_WORDS_RE = _rc(r"""^[a-z]+(?:\.[a-z]+){2,}$""")
CREDENTIAL_IDENTIFIER_RE = _rc(r"""^(?:_*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+_*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z]+)$""")
CREDENTIAL_PATH_RE = _rc(r"""^(?:(?:~|\.{1,2})?\/|[A-Za-z]:[\\\/]|\\\\)[^+=]*$|^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$""")
CREDENTIAL_FILE_EXT_RE = _rc(r"""\.[A-Za-z][A-Za-z0-9]{0,4}$""")
CREDENTIAL_FILE_NAME_RE = _rc(r"""^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:json|ya?ml|pem|p8|p12|pfx|key|keystore|jks|crt|cer|der|txt|ini|toml|conf|cfg|xml|properties|env|gpg|asc|ppk|pub|kdbx)$""")
CREDENTIAL_HOST_NAME_RE = _rc(r"""^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.(?:com|net|org|io|dev|app|cloud|internal|local|svc|co|ai|sh)$""")
CREDENTIAL_SLUG_RE = _rc(r"""^[a-z0-9]+(?:[-.][a-z0-9]+)+$""")
CREDENTIAL_SLUG_SHORT_WORD_RE = _rc(r"""(?:^|[-.])(?:[a-z0-9]{1,3}|[a-z]*[0-9][a-z0-9]*)(?:[-.]|$)""")
CREDENTIAL_OBJECT_NAME_RE = _rc(r"""_(?:SECRET|CREDENTIALS)(?![A-Za-z0-9_])""")
CREDENTIAL_LETTERS_RE = _rc(r"""^[A-Za-z]+(?:[-_.][A-Za-z]+)*$""")
CREDENTIAL_DESCRIPTIVE_WORDS = _rc(r"""(?:^|-)(?:keys?|tokens?|secrets?|pass|passwords?|passwd|pwd|api|apikey|auth|credentials?|access|private|here|value|string|my|your|default|dev|development|local|prod|production|staging|none|null|empty|required|some|generated|random|change|replace|set|use|put|enter|fill|ask|get|see|from|the|not|check|contact|generate|read|find|fake|mock|tests?|dummy|example|sample|placeholder|todo)(?:-|$)|secret|passw|token|apikey|changeme|example|placeholder|dummy""")
CREDENTIAL_HEX_RE = _rc(r"""^[0-9A-Fa-f]{32,}$""")
WORD_TOKEN_RE = _rc(r"""[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+""")
_DIGIT_RE = _rc(r'[0-9]')
_LOWER_RE = _rc(r'[a-z]')
_UPPER_RE = _rc(r'[A-Z]')
_SYMBOL_RE = _rc(r'[^A-Za-z0-9]')
_CHAIN_SPLIT_RE = _rc(r'\?\.|\.|::|->')
_CHAIN_SEP_RE = _rc(r'\.|::|->')
_PATH_SPLIT_RE = _rc(r'[\\\/]')
_PATH_ROOT_RE = _rc(r'^[~.\/\\]|^[A-Za-z]:')
_URL_PASSWORD_REF_RE = _rc(r'^[$%<{]')
_HEX_LETTER_RE = _rc(r'[A-Fa-f]')
_SLUG_SPLIT_RE = _rc(r'[-.]')
_REF_SPLIT_RE = _rc(r'[-_.]')
_DESCRIPTIVE_HINTS = ('key', 'token', 'secret', 'pass', 'pwd', 'api', 'auth', 'credential', 'access', 'private',
                      'here', 'value', 'string', 'my', 'your', 'default', 'dev', 'local', 'prod', 'staging', 'none',
                      'null', 'empty', 'required', 'some', 'generated', 'random', 'change', 'replace', 'set', 'use',
                      'put', 'enter', 'fill', 'ask', 'get', 'see', 'from', 'the', 'not', 'check', 'contact',
                      'generate', 'read', 'find', 'fake', 'mock', 'test', 'dummy', 'example', 'sample', 'placeholder', 'todo')


def _utf16_len(s: str) -> int:
    return len(s) if s.isascii() else len(s.encode("utf-16-le", "surrogatepass")) // 2


def _entropy(s: str, n: int) -> float:
    """Shannon entropy per character; n is the length of s in UTF-16 units.
    Characters are summed in order of first appearance, as in Node.js."""
    h = 0.0
    for c in Counter(s).values():
        p = c / n
        h -= p * math.log2(p)
    return h


def _looks_machine_generated(v: str, n: int) -> bool:
    """Three character classes and at least 3 bits per character with a digit;
    without one, see looksMachineGenerated in rules.js."""
    digit = _DIGIT_RE.search(v) is not None
    classes = (1 if _LOWER_RE.search(v) else 0) + (1 if _UPPER_RE.search(v) else 0) + (1 if digit else 0) + (1 if _SYMBOL_RE.search(v) else 0)
    if classes < 3:
        return False
    if digit:
        return _entropy(v, n) >= 3.0
    return n >= 16 and _entropy(v, n) >= 3.5 and _machine_like_part(v)


def _machine_like_part(s: str) -> bool:
    """Text that reads as random rather than as words (see machineLikePart)."""
    if len(s) < 10:
        return False
    alnum = len(_SYMBOL_RE.sub('', s))
    if alnum < 10:
        return False
    if alnum >= 20 and _DIGIT_RE.search(s) and _LOWER_RE.search(s) and _UPPER_RE.search(s):
        return True
    return alnum * 2 < len(WORD_TOKEN_RE.findall(s)) * 5


def _looks_like_code(v: str) -> bool:
    m = CREDENTIAL_CODE_RE.search(v)
    if m and m.group(2) is not None:
        return not any(_machine_like_part(p) for p in _CHAIN_SPLIT_RE.split(m.group(1)))
    if CREDENTIAL_DOTTED_WORDS_RE.search(v):
        return False
    if m and _CHAIN_SEP_RE.search(m.group(1)):
        return not any(_machine_like_part(p) for p in _CHAIN_SPLIT_RE.split(m.group(1)))
    return bool(CREDENTIAL_IDENTIFIER_RE.search(v)) and not any(_machine_like_part(p) for p in v.split('_'))


def _looks_like_path(v: str) -> bool:
    if not CREDENTIAL_PATH_RE.search(v):
        return False
    if not _PATH_ROOT_RE.search(v) and not CREDENTIAL_FILE_EXT_RE.search(v):
        return False
    return not any(_machine_like_part(p) for p in _PATH_SPLIT_RE.split(v))


def _placeholder_mark(v: str, lv: str) -> bool:
    """A placeholder mark inside the value; lv is v with ASCII letters lower-cased."""
    if CREDENTIAL_PLACEHOLDER_MARK_RE.search(v):
        return True
    return any(m in lv for m in CREDENTIAL_PLACEHOLDER_MARKS)


def _is_reference(v: str) -> bool:
    """A whole-value reference whose inner part does not look random (see isReference)."""
    m = CREDENTIAL_REFERENCE_RE.search(v)
    if not m:
        return False
    inner = next(g for g in m.groups() if g is not None)
    if not CREDENTIAL_REFERENCE_NAME_RE.search(inner):
        return False
    return not (_looks_machine_generated(inner, _utf16_len(inner)) or any(_machine_like_part(p) for p in _REF_SPLIT_RE.split(inner)))


def _is_placeholder_value(v: str) -> bool:
    lv = v.translate(_ASCII_LOWER)
    if CREDENTIAL_PLACEHOLDER_RE.search(v) or _is_reference(v) or _placeholder_mark(v, lv):
        return True
    return _PLACEHOLDER_WORDS_LOWER.search(lv) is not None


def _looks_like_name(v: str) -> bool:
    """A file name with a known extension, or a host name."""
    if CREDENTIAL_FILE_NAME_RE.search(v) and not _machine_like_part(v):
        return True
    return CREDENTIAL_HOST_NAME_RE.search(v) is not None


def _looks_like_slug(v: str, prefix: str) -> bool:
    """Lower-case words joined by "-" that name an object (see looksLikeSlug)."""
    if not CREDENTIAL_SLUG_RE.search(v):
        return False
    words = len(_SLUG_SPLIT_RE.split(v))
    if words <= 2:
        return True
    short_word = CREDENTIAL_SLUG_SHORT_WORD_RE.search(v) is not None
    object_name = CREDENTIAL_OBJECT_NAME_RE.search(prefix) is not None
    return (words == 3 and (short_word or (object_name and '.' not in v))) or (object_name and short_word)


def _describes_itself(v: str, lv: str) -> bool:
    if not CREDENTIAL_LETTERS_RE.search(v):
        return False
    # Every descriptive word contains one of these: skip the split when none occurs.
    if not any(h in lv for h in _DESCRIPTIVE_HINTS):
        return False
    return bool(CREDENTIAL_DESCRIPTIVE_WORDS.search('-'.join(WORD_TOKEN_RE.findall(v)).lower()))


_NOT_SECRET, _SECRET, _GENERATED_SECRET = 0, 1, 2


def _credential_value_kind(value: str, prefix: str = '') -> int:
    if _utf16_len(value) > MAX_FILTERED_VALUE:
        return _GENERATED_SECRET
    v = value.rstrip(';,')
    if not v or '[REDACTED_' in v:
        return _NOT_SECRET
    url = CREDENTIAL_URL_RE.search(v)
    if url:
        pwd = url.group(1)
        if not pwd or _URL_PASSWORD_REF_RE.search(pwd) or _is_placeholder_value(pwd):
            return _NOT_SECRET
        return _GENERATED_SECRET
    if CREDENTIAL_STORE_RE.search(v) or CREDENTIAL_CODE_ROOT_RE.search(v) or CREDENTIAL_PLACEHOLDER_RE.search(v) or _is_reference(v):
        return _NOT_SECRET
    if _looks_like_name(v) or _looks_like_code(v) or _looks_like_path(v):
        return _NOT_SECRET
    n = _utf16_len(v)
    generated = _looks_machine_generated(v, n)
    lv = v.translate(_ASCII_LOWER)
    if not CREDENTIAL_REFERENCE_RE.search(v) and _placeholder_mark(v, lv):
        return _GENERATED_SECRET if generated else _NOT_SECRET
    if _PLACEHOLDER_WORDS_LOWER.search(lv):
        return _GENERATED_SECRET if generated and n >= 24 and _machine_like_part(v) else _NOT_SECRET
    if generated:
        return _GENERATED_SECRET
    if _describes_itself(v, lv) or _looks_like_slug(v, prefix):
        return _NOT_SECRET
    if CREDENTIAL_HEX_RE.search(v) and _DIGIT_RE.search(v) and _HEX_LETTER_RE.search(v):
        return _GENERATED_SECRET
    return _SECRET


def _is_non_secret_value(value: str, prefix: str = '') -> bool:
    return _credential_value_kind(value, prefix) == _NOT_SECRET


def _is_non_secret_default(value: str, prefix: str = '') -> bool:
    """Defaults are only redacted when they look machine-generated."""
    return _credential_value_kind(value, prefix) != _GENERATED_SECRET


# Rules whose match is only redacted when the value (group 2) is a secret.
SECRET_VALUE_FILTERS = {
    "secret:env_credential": _is_non_secret_value,
    "secret:prefixed_credential": _is_non_secret_value,
    "secret:credential_default": _is_non_secret_default,
}

# ---------------------------------------------------------------------------
# Provider token formats. The bodies, boundaries and checks follow the token
# table in packages/zn-gate/lib/scrub/patterns.js (the Node.js scrubber), so
# both engines redact the same credential formats. They are kept apart from
# SECRET_PATTERNS, which mirrors the rules.js secret:* list one for one
# (tests/test_rules_parity.py). Each entry is (rule id, regex, replacement).
#   PROVIDER_MATCH_CHECKS: a check on the whole match (patterns.js `check`).
#   PROVIDER_VALUE_FILTERS: group 2 with group 1 as the prefix; True means
#     "not a secret", as in SECRET_VALUE_FILTERS.
# Every regex is linear: bounded repeats and token boundaries, no nesting.
# ---------------------------------------------------------------------------
_TB = r'(?<![A-Za-z0-9_-])'    # start of a token
_TA = r'(?![A-Za-z0-9_-])'     # end of a token
_ALNUM_B = r'(?<![A-Za-z0-9])'
_ALNUM_A = r'(?![A-Za-z0-9])'
_TOKEN_ALPHA_RE = _rc(r'[A-Za-z]')


def _pv_shannon(s: str) -> float:
    """Shannon entropy in bits per character (patterns.js shannon)."""
    if not s:
        return 0.0
    n = len(s)
    h = 0.0
    for count in Counter(s).values():
        p = count / n
        h -= p * math.log2(p)
    return h


def _pv_random(s: str, classes: int = 2, bits: float = 3.0) -> bool:
    """patterns.js looksRandom: enough character classes and entropy."""
    found = ((1 if _LOWER_RE.search(s) else 0) + (1 if _UPPER_RE.search(s) else 0)
             + (1 if _DIGIT_RE.search(s) else 0) + (1 if _SYMBOL_RE.search(s) else 0))
    return found >= classes and _pv_shannon(s) >= bits


_PV_PLACEHOLDER_RE = _rc(
    r'x{3,}|\*{3,}|\.{3,}|-+|_+|<[^>]*>|\$\{?[^}]*\}?|\{\{?[^}]*\}?\}|%\(?[a-z_]*\)?s|:[a-z_]+|\[[^\]]*\]',
    re.IGNORECASE | re.ASCII)
_PV_PLACEHOLDER_WORDS = _rc(
    r'(?:^|[^a-z])(?:password|passwd|passw0rd|secret|changeme|change_me|example|placeholder|your[_-]?|'
    r'redacted|dummy|sample|foobar|hunter2|xxxx|todo|insert|replace|mypass|pass(?:word)?123)(?:[^a-z]|$)',
    re.IGNORECASE | re.ASCII)
_PV_PLACEHOLDER_SEQ = _rc(r'0123456789|1234567890|abcdef|qwerty', re.IGNORECASE | re.ASCII)
_PV_POLAR_PREFIX = _rc(r'polar_(?:oat|pat|(?:at|rt)_[uo]|ci|cs)_')


def _pv_placeholder(s: str) -> bool:
    """patterns.js isPlaceholder."""
    if not s or _PV_PLACEHOLDER_RE.fullmatch(s) or _PV_PLACEHOLDER_WORDS.search(s):
        return True
    return bool(re.fullmatch(r'(.)\1+', s) or _PV_PLACEHOLDER_SEQ.match(s))


def _pv_prefixed(v: str, prefix: str) -> bool:
    """patterns.js prefixedRandom: the body after the prefix looks random and is not a placeholder."""
    body = re.sub(prefix, '', v, count=1)
    return not _pv_placeholder(body) and _pv_random(body, 2, 3.0)


def _pv_hf_check(v: str) -> bool:
    # Letters-only bodies are exactly 34 characters; CamelCase identifiers do not count.
    body = v[3:]
    if re.fullmatch(r'[A-Za-z]{34}', body) and not re.fullmatch(r'[a-z]*(?:[A-Z][a-z]{2,})*[A-Z]{0,3}[a-z]{0,2}', body):
        return True
    return _pv_random(body, 3, 3.8)


def _pv_url_password_not_secret(pw: str, prefix: str) -> bool:
    # prefix is "scheme://user:"; the same exclusions as patterns.js DB_PASSWORD.
    cut = prefix.find('://')
    scheme = prefix[:cut].lower()
    user = prefix[cut + 3:-1]
    if len(pw) < 6 or _pv_placeholder(pw) or pw == user or pw.lower() == scheme:
        return True
    # A password that is only a reference ($NAME, ${NAME}, %NAME%, <name>, {{name}}) is not a
    # literal secret; one that merely starts with one of those characters still is. GitHub's
    # fixed "x-oauth-basic" password is not one either (the token is then the user, found by
    # its own pattern). A reference as the user does not make a literal password safe.
    if pw.lower() == "x-oauth-basic":
        return True
    if re.fullmatch(r'\$\{?\w+\}?|%\w+%|<[^<>\s]+>|\{\{?\s*[\w.]+\s*\}?\}', pw):
        return True
    if re.fullmatch(r'[A-Za-z]{1,8}', pw) or re.fullmatch(r'(?:%[0-9A-Fa-f]{2}){1,2}', pw):
        return True
    return False


def _pv_bearer_not_secret(token: str, prefix: str) -> bool:
    # zn's own __ZN_<NAME>__ markers are not secrets.
    return _pv_placeholder(token) or re.fullmatch(r'__ZN_[A-Z0-9_]+__', token) is not None


PROVIDER_SECRET_PATTERNS: List[Tuple[str, re.Pattern[str], str]] = [
    ("secret:aws_key_id", _rc(_ALNUM_B + r'(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}' + _ALNUM_A), "[REDACTED_AWS_KEY]"),
    ("secret:gitlab_token", _rc(_TB + r'gl(?:pat|dt|rt|ptt|cbt|ft|soat)-[A-Za-z0-9_-]{20,}' + _TA), "[REDACTED_GITLAB_TOKEN]"),
    ("secret:slack_token", _rc(_TB + r'(?:xox[abeprs]-[0-9]{6,}-[A-Za-z0-9-]{8,}|xapp-[0-9]-[A-Z0-9]{6,}-[0-9]{6,}-[a-f0-9]{32,})' + _TA), "[REDACTED_SLACK_TOKEN]"),
    ("secret:slack_webhook", _rc(r'https://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9/_-]{20,}'), "[REDACTED_SLACK_WEBHOOK]"),
    ("secret:discord_webhook", _rc(r'https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/[0-9]{15,20}/[A-Za-z0-9_-]{60,}'), "[REDACTED_DISCORD_WEBHOOK]"),
    ("secret:stripe_key", _rc(_TB + r'(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{20,247}' + _TA), "[REDACTED_STRIPE_KEY]"),
    ("secret:stripe_webhook_secret", _rc(_TB + r'whsec_[A-Za-z0-9+/]{32,}' + _TA), "[REDACTED_STRIPE_WEBHOOK_SECRET]"),
    ("secret:google_api_key", _rc(_TB + r'AIza[0-9A-Za-z_-]{35}' + _TA), "[REDACTED_GOOGLE_API_KEY]"),
    ("secret:google_oauth_secret", _rc(_TB + r'GOCSPX-[A-Za-z0-9_-]{28}' + _TA), "[REDACTED_GOOGLE_OAUTH_SECRET]"),
    ("secret:hf_token", _rc(_TB + r'hf_[A-Za-z0-9]{34,40}' + _TA), "[REDACTED_HF_TOKEN]"),
    ("secret:npm_token", _rc(_TB + r'npm_[A-Za-z0-9]{36}' + _TA), "[REDACTED_NPM_TOKEN]"),
    ("secret:pypi_token", _rc(_TB + r'pypi-AgE[A-Za-z0-9_-]{50,}' + _TA), "[REDACTED_PYPI_TOKEN]"),
    ("secret:sendgrid_key", _rc(_TB + r'SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}' + _TA), "[REDACTED_SENDGRID_KEY]"),
    ("secret:twilio_key", _rc(_ALNUM_B + r'SK(?:[0-9a-f]{32}|[0-9A-F]{32})' + _ALNUM_A), "[REDACTED_TWILIO_KEY]"),
    ("secret:mailgun_key", _rc(_TB + r'key-[0-9a-f]{32}' + _TA), "[REDACTED_MAILGUN_KEY]"),
    ("secret:shopify_token", _rc(_TB + r'shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}' + _TA), "[REDACTED_SHOPIFY_TOKEN]"),
    ("secret:digitalocean_token", _rc(_TB + r'do[opr]_v1_[a-f0-9]{64}' + _TA), "[REDACTED_DIGITALOCEAN_TOKEN]"),
    ("secret:linear_key", _rc(_TB + r'lin_api_[A-Za-z0-9]{40}' + _TA), "[REDACTED_LINEAR_KEY]"),
    ("secret:telegram_bot_token", _rc(_ALNUM_B + r'[0-9]{8,10}:AA[A-Za-z0-9_-]{33}' + _TA), "[REDACTED_TELEGRAM_BOT_TOKEN]"),
    ("secret:azure_storage_key", _rc(r'(AccountKey=)([A-Za-z0-9+/]{86}==)'), r'\1[REDACTED_AZURE_STORAGE_KEY]'),
    ("secret:databricks_token", _rc(_TB + r'dapi[a-f0-9]{32}(?:-[0-9])?' + _TA), "[REDACTED_DATABRICKS_TOKEN]"),
    ("secret:vault_token", _rc(_TB + r'hv[sb]\.[A-Za-z0-9_-]{24,}' + _TA), "[REDACTED_VAULT_TOKEN]"),
    ("secret:doppler_token", _rc(_TB + r'dp\.(?:st|pt|sa|scim|audit|ct)\.[A-Za-z0-9_.-]{40,}' + _TA), "[REDACTED_DOPPLER_TOKEN]"),
    ("secret:newrelic_key", _rc(_TB + r'NR(?:AK|II)-[A-Z0-9]{27}' + _TA), "[REDACTED_NEWRELIC_KEY]"),
    ("secret:groq_key", _rc(_TB + r'gsk_[A-Za-z0-9]{52}' + _TA), "[REDACTED_GROQ_KEY]"),
    ("secret:xai_key", _rc(_TB + r'xai-[A-Za-z0-9]{80}' + _TA), "[REDACTED_XAI_KEY]"),
    ("secret:dockerhub_pat", _rc(_TB + r'dckr_(?:pat|oat)_[A-Za-z0-9_-]{20,}' + _TA), "[REDACTED_DOCKERHUB_PAT]"),
    ("secret:tavily_key", _rc(_TB + r'tvly-[A-Za-z0-9_-]{20,}' + _TA), "[REDACTED_TAVILY_KEY]"),
    ("secret:firecrawl_key", _rc(_TB + r'fc-[A-Za-z0-9]{20,}' + _TA), "[REDACTED_FIRECRAWL_KEY]"),
    ("secret:polar_token", _rc(_TB + r'polar_(?:oat|pat|(?:at|rt)_[uo]|ci|cs)_[A-Za-z0-9_-]{20,}' + _TA), "[REDACTED_POLAR_TOKEN]"),
    ("secret:replicate_token", _rc(_TB + r'r8_[A-Za-z0-9]{37}' + _TA), "[REDACTED_REPLICATE_TOKEN]"),
    ("secret:supabase_pat", _rc(_TB + r'sbp_[A-Za-z0-9_-]{30,}' + _TA), "[REDACTED_SUPABASE_PAT]"),
    ("secret:square_token", _rc(_TB + r'(?:EAAA[A-Za-z0-9_-]{60}|sq0atp-[A-Za-z0-9_-]{22}|sq0csp-[A-Za-z0-9_-]{43})' + _TA),
     "[REDACTED_SQUARE_TOKEN]"),
    ("secret:discord_bot_token", _rc(_TB + r'[MNO][A-Za-z0-9_-]{22,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}' + _TA),
     "[REDACTED_DISCORD_BOT_TOKEN]"),
    # Provider formats from gitleaks v8.30.1 (MIT License, Copyright (c) 2019 Zachary Rice; notice at the end of this file).
    ("secret:onepassword_sa_token", _rc(_TB + r'ops_eyJ[A-Za-z0-9+/]{250,}={0,3}' + _TA), "[REDACTED_ONEPASSWORD_SA_TOKEN]"),
    ("secret:age_secret_key", _rc(_TB + r'AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}' + _TA), "[REDACTED_AGE_SECRET_KEY]"),
    ("secret:alibaba_key_id", _rc(_TB + r'LTAI[A-Za-z0-9]{20}' + _TA), "[REDACTED_ALIBABA_KEY_ID]"),
    ("secret:artifactory_key", _rc(_TB + r'AKCp[A-Za-z0-9]{69}' + _TA), "[REDACTED_ARTIFACTORY_KEY]"),
    ("secret:cloudflare_origin_ca_key", _rc(_TB + r'v1\.0-[a-f0-9]{24}-[a-f0-9]{146}' + _TA), "[REDACTED_CLOUDFLARE_ORIGIN_CA_KEY]"),
    ("secret:dynatrace_token", _rc(_TB + r'dt0c01\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{64}' + _TA), "[REDACTED_DYNATRACE_TOKEN]"),
    ("secret:easypost_key", _rc(_TB + r'EZ(?:AK|TK)[A-Za-z0-9]{54}' + _TA), "[REDACTED_EASYPOST_KEY]"),
    ("secret:flyio_token", _rc(_TB + r'(?:fo1_[A-Za-z0-9_-]{43}|fm1[ar]_[A-Za-z0-9+/]{100,}={0,3}|fm2_[A-Za-z0-9+/]{100,}={0,3})' + _TA), "[REDACTED_FLYIO_TOKEN]"),
    ("secret:grafana_token", _rc(_TB + r'(?:glc_[A-Za-z0-9+/]{32,400}={0,3}|glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})' + _TA), "[REDACTED_GRAFANA_TOKEN]"),
    ("secret:terraform_cloud_token", _rc(_TB + r'[a-z0-9]{14}\.atlasv1\.[A-Za-z0-9_=-]{60,70}' + _TA), "[REDACTED_TERRAFORM_CLOUD_TOKEN]"),
    ("secret:heroku_key_v2", _rc(_TB + r'HRKU-AA[A-Za-z0-9_-]{58}' + _TA), "[REDACTED_HEROKU_KEY_V2]"),
    ("secret:notion_token", _rc(_TB + r'ntn_[0-9]{11}[A-Za-z0-9]{35}' + _TA), "[REDACTED_NOTION_TOKEN]"),
    ("secret:perplexity_key", _rc(_TB + r'pplx-[A-Za-z0-9]{48}' + _TA), "[REDACTED_PERPLEXITY_KEY]"),
    ("secret:planetscale_token", _rc(_TB + r'pscale_(?:tkn|oauth|pw)_[A-Za-z0-9_=.-]{32,64}' + _TA), "[REDACTED_PLANETSCALE_TOKEN]"),
    ("secret:postman_key", _rc(_TB + r'PMAK-[A-Fa-f0-9]{24}-[A-Fa-f0-9]{34}' + _TA), "[REDACTED_POSTMAN_KEY]"),
    ("secret:prefect_key", _rc(_TB + r'pnu_[A-Za-z0-9]{36}' + _TA), "[REDACTED_PREFECT_KEY]"),
    ("secret:pulumi_token", _rc(_TB + r'pul-[a-f0-9]{40}' + _TA), "[REDACTED_PULUMI_TOKEN]"),
    ("secret:readme_key", _rc(_TB + r'rdme_[a-z0-9]{70}' + _TA), "[REDACTED_README_KEY]"),
    ("secret:rubygems_key", _rc(_TB + r'rubygems_[a-f0-9]{48}' + _TA), "[REDACTED_RUBYGEMS_KEY]"),
    ("secret:brevo_key", _rc(_TB + r'xkeysib-[a-f0-9]{64}-[A-Za-z0-9]{16}' + _TA), "[REDACTED_BREVO_KEY]"),
    ("secret:sentry_user_token", _rc(_TB + r'sntryu_[a-f0-9]{64}' + _TA), "[REDACTED_SENTRY_USER_TOKEN]"),
    ("secret:shippo_key", _rc(_TB + r'shippo_(?:live|test)_[a-fA-F0-9]{40}' + _TA), "[REDACTED_SHIPPO_KEY]"),
    ("secret:openshift_token", _rc(_TB + r'sha256~[A-Za-z0-9_-]{43}' + _TA), "[REDACTED_OPENSHIFT_TOKEN]"),
    ("secret:teams_webhook", _rc(_TB + r'https://[a-z0-9]+\.webhook\.office\.com/webhookb2/[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}@[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}/IncomingWebhook/[a-z0-9]{32}/[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}' + _TA), "[REDACTED_TEAMS_WEBHOOK]"),
    ("secret:azure_ad_client_secret", _rc(r'(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.]{3}[0-9]Q~[A-Za-z0-9_~.-]{30,33}[A-Za-z0-9_~-](?![A-Za-z0-9_~-])(?!\.[A-Za-z0-9_~-])'), "[REDACTED_AZURE_AD_CLIENT_SECRET]"),
    # Password segment of scheme://user:password@host (any scheme, as DB_PASSWORD in patterns.js).
    # ASCII word boundary like the scrubber: a scheme after CJK or accented letters is still a URL.
    ("secret:url_password", _rc(r"((?<![A-Za-z0-9_])[a-zA-Z][a-zA-Z0-9+._-]{1,40}://[^\s:@/?#'\"`<>]{0,128}:)([^\s@/?#'\"`<>]{1,256})(@(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]))"), r'\1[REDACTED_URL_PASSWORD]\3'),
    # Authorization header with a bearer token (BEARER_TOKEN in patterns.js). zn's
    # own __ZN_<NAME>__ markers are not secrets (_pv_bearer_not_secret).
    ("secret:bearer_token", _rc(r'(Authorization[ \t]*:[ \t]*Bearer[ \t]+)([A-Za-z0-9._~+/=-]{20,})', re.IGNORECASE | re.ASCII), r'\1[REDACTED_BEARER_TOKEN]'),
]

# Whole-match checks (patterns.js `check`), keyed by rule id.
def _pv_discord_check(v: str) -> bool:
    """A Discord bot token's first part is the base64url of the bot's numeric id (17-20 digits)."""
    ident, _, rest = v.partition('.')
    mac = rest.partition('.')[2]
    try:
        digits = base64.urlsafe_b64decode(ident + '=' * (-len(ident) % 4)).decode('latin-1')
    except (ValueError, binascii.Error):
        return False
    return re.fullmatch(r'[0-9]{17,20}', digits) is not None and _pv_random(mac, 2, 3.0)


PROVIDER_MATCH_CHECKS: Dict[str, Any] = {
    "secret:aws_key_id": lambda v: re.fullmatch(r'(.)\1+', v[4:]) is None,
    "secret:stripe_key": lambda v: _pv_random(v[8:], 2, 3.5),
    "secret:gitlab_token": lambda v: _pv_random(v[v.index('-') + 1:], 2, 3.3),
    "secret:hf_token": _pv_hf_check,
    "secret:npm_token": lambda v: _pv_random(v[4:], 3, 3.8),
    "secret:twilio_key": lambda v: bool(_DIGIT_RE.search(v[2:])) and bool(re.search(r'[a-fA-F]', v[2:])),
    "secret:mailgun_key": lambda v: bool(_DIGIT_RE.search(v[4:])) and bool(re.search(r'[a-f]', v[4:])),
    "secret:databricks_token": lambda v: bool(_DIGIT_RE.search(v[4:])) and bool(re.search(r'[a-f]', v[4:])),
    "secret:dockerhub_pat": lambda v: _pv_random(v.split('_', 2)[2], 2, 3.3),
    "secret:tavily_key": lambda v: bool(_DIGIT_RE.search(v[5:])) and _pv_random(v[5:], 2, 3.3),
    "secret:firecrawl_key": lambda v: bool(_DIGIT_RE.search(v[3:])) and _pv_random(v[3:], 2, 3.3),
    "secret:polar_token": lambda v: _pv_random(_PV_POLAR_PREFIX.sub('', v, count=1), 2, 3.3),
    "secret:replicate_token": lambda v: _pv_random(v[3:], 2, 3.3),
    "secret:supabase_pat": lambda v: bool(_DIGIT_RE.search(v[4:])) and _pv_random(v[4:], 2, 3.3),
    "secret:square_token": lambda v: _pv_random(re.sub(r'^(?:EAAA|sq0atp-|sq0csp-)', '', v), 2, 3.3),
    "secret:discord_bot_token": lambda v: _pv_discord_check(v),
    "secret:onepassword_sa_token": lambda v: _pv_prefixed(v, r'^ops_eyJ'),
    "secret:age_secret_key": lambda v: _pv_prefixed(v, r'^AGE-SECRET-KEY-1'),
    "secret:alibaba_key_id": lambda v: _pv_prefixed(v, r'^LTAI'),
    "secret:artifactory_key": lambda v: _pv_prefixed(v, r'^AKCp'),
    "secret:cloudflare_origin_ca_key": lambda v: _pv_prefixed(v, r'^v1\.0-'),
    "secret:dynatrace_token": lambda v: _pv_prefixed(v, r'^dt0c01\.'),
    "secret:easypost_key": lambda v: _pv_prefixed(v, r'^EZ(?:AK|TK)'),
    "secret:flyio_token": lambda v: _pv_prefixed(v, r'^(?:fo1|fm1[ar]|fm2)_'),
    "secret:grafana_token": lambda v: _pv_prefixed(v, r'^gl(?:c|sa)_'),
    "secret:terraform_cloud_token": lambda v: _pv_prefixed(v, r'^[a-z0-9]{14}\.atlasv1\.'),
    "secret:heroku_key_v2": lambda v: _pv_prefixed(v, r'^HRKU-AA'),
    "secret:notion_token": lambda v: _pv_prefixed(v, r'^ntn_[0-9]{11}'),
    "secret:perplexity_key": lambda v: _pv_prefixed(v, r'^pplx-'),
    "secret:planetscale_token": lambda v: _pv_prefixed(v, r'^pscale_(?:tkn|oauth|pw)_'),
    "secret:postman_key": lambda v: _pv_prefixed(v, r'^PMAK-'),
    "secret:prefect_key": lambda v: _pv_prefixed(v, r'^pnu_'),
    "secret:pulumi_token": lambda v: _pv_prefixed(v, r'^pul-'),
    "secret:readme_key": lambda v: _pv_prefixed(v, r'^rdme_'),
    "secret:rubygems_key": lambda v: _pv_prefixed(v, r'^rubygems_'),
    "secret:brevo_key": lambda v: _pv_prefixed(v, r'^xkeysib-'),
    "secret:sentry_user_token": lambda v: _pv_prefixed(v, r'^sntryu_'),
    "secret:shippo_key": lambda v: _pv_prefixed(v, r'^shippo_(?:live|test)_'),
    "secret:openshift_token": lambda v: _pv_prefixed(v, r'^sha256~'),
    "secret:teams_webhook": lambda v: _pv_prefixed(v, r'^https://[a-z0-9]+\.webhook\.office\.com/webhookb2/'),
    "secret:azure_ad_client_secret": lambda v: _pv_random(v, 3, 3.5),
}

# Value filters (group 2, prefix group 1); True means the value is not a secret.
PROVIDER_VALUE_FILTERS: Dict[str, Any] = {
    "secret:url_password": _pv_url_password_not_secret,
    "secret:bearer_token": _pv_bearer_not_secret,
}

# Literal hints, as in patterns.js: the rule runs only when the text holds one of
# them (a substring search, much cheaper than a regex pass on every line).
# A rule without an entry always runs (the bearer rule: its header name is
# matched without case rules).
PROVIDER_HINTS: Dict[str, Tuple[str, ...]] = {
    "secret:aws_key_id": ("AKIA", "ASIA", "ABIA", "ACCA"),
    "secret:gitlab_token": ("glpat-", "gldt-", "glrt-", "glptt-", "glcbt-", "glft-", "glsoat-"),
    "secret:slack_token": ("xox", "xapp-"),
    "secret:slack_webhook": ("hooks.slack.com",),
    "secret:discord_webhook": ("/api/webhooks/",),
    "secret:stripe_key": ("_live_", "_test_", "_prod_"),
    "secret:stripe_webhook_secret": ("whsec_",),
    "secret:google_api_key": ("AIza",),
    "secret:google_oauth_secret": ("GOCSPX-",),
    "secret:hf_token": ("hf_",),
    "secret:npm_token": ("npm_",),
    "secret:pypi_token": ("pypi-",),
    "secret:sendgrid_key": ("SG.",),
    "secret:twilio_key": ("SK",),
    "secret:mailgun_key": ("key-",),
    "secret:shopify_token": ("shpat_", "shpca_", "shppa_", "shpss_"),
    "secret:digitalocean_token": ("_v1_",),
    "secret:linear_key": ("lin_api_",),
    "secret:telegram_bot_token": (":AA",),
    "secret:azure_storage_key": ("AccountKey=",),
    "secret:databricks_token": ("dapi",),
    "secret:vault_token": ("hvs.", "hvb."),
    "secret:doppler_token": ("dp.",),
    "secret:newrelic_key": ("NRAK-", "NRII-"),
    "secret:groq_key": ("gsk_",),
    "secret:xai_key": ("xai-",),
    "secret:dockerhub_pat": ("dckr_pat_", "dckr_oat_"),
    "secret:tavily_key": ("tvly-",),
    "secret:firecrawl_key": ("fc-",),
    "secret:polar_token": ("polar_",),
    "secret:replicate_token": ("r8_",),
    "secret:supabase_pat": ("sbp_",),
    "secret:square_token": ("EAAA", "sq0atp-", "sq0csp-"),
    "secret:discord_bot_token": (".",),
    "secret:onepassword_sa_token": ('ops_eyJ',),
    "secret:age_secret_key": ('AGE-SECRET-KEY-1',),
    "secret:alibaba_key_id": ('LTAI',),
    "secret:artifactory_key": ('AKCp',),
    "secret:cloudflare_origin_ca_key": ('v1.0-',),
    "secret:dynatrace_token": ('dt0c01.',),
    "secret:easypost_key": ('EZAK', 'EZTK',),
    "secret:flyio_token": ('fo1_', 'fm1a_', 'fm1r_', 'fm2_',),
    "secret:grafana_token": ('glc_', 'glsa_',),
    "secret:terraform_cloud_token": ('.atlasv1.',),
    "secret:heroku_key_v2": ('HRKU-AA',),
    "secret:notion_token": ('ntn_',),
    "secret:perplexity_key": ('pplx-',),
    "secret:planetscale_token": ('pscale_',),
    "secret:postman_key": ('PMAK-',),
    "secret:prefect_key": ('pnu_',),
    "secret:pulumi_token": ('pul-',),
    "secret:readme_key": ('rdme_',),
    "secret:rubygems_key": ('rubygems_',),
    "secret:brevo_key": ('xkeysib-',),
    "secret:sentry_user_token": ('sntryu_',),
    "secret:shippo_key": ('shippo_',),
    "secret:openshift_token": ('sha256~',),
    "secret:teams_webhook": ('webhook.office.com',),
    "secret:azure_ad_client_secret": ("Q~",),
    "secret:url_password": ("://",),
}

# ---------------------------------------------------------------------------
# Extra credential forms that only `zn-gate scan` reports (files at rest, not
# agent traffic). Same table as SCAN_SECRET_PATTERNS in rules.js (see the
# comment there); they run after SECRET_PATTERNS and the provider formats, on
# the text those already redacted.
# ---------------------------------------------------------------------------
SCAN_SECRET_PATTERNS: List[Tuple[str, re.Pattern[str], str]] = [
    ("secret:cli_credential_flag", _rc(r"""(?<![A-Za-z0-9_-])(--(?:api[-_]?key|password|passwd|token|secret|access[-_]token|auth[-_]token|client[-_]secret)=["']?)([^\s'"]{8,512})[^\s'"]*(["']?)"""), r'\1[REDACTED_SECRET]\3'),
    # The name is at most 40 characters before the keyword, so each start costs a bounded amount.
    ("secret:credential_assignment", _rc(r"""(?<![A-Za-z0-9_$])(\$?[A-Za-z0-9_]{0,40}?(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy])["']?[ \t]*(?::=|=>|=|:)[ \t]*["'])([^\s'"]{8,512})(["'])"""), r'\1[REDACTED_SECRET]\3'),
]

SCAN_SECRET_VALUE_FILTERS = {
    "secret:cli_credential_flag": _is_non_secret_value,
    # Only values that look machine-generated: labels and messages are not secrets.
    "secret:credential_assignment": _is_non_secret_default,
}

SCAN_SECRET_PREFILTERS: Dict[str, re.Pattern[str]] = {
    "secret:cli_credential_flag": _rc(r"""--(?:api|pass|token|secret|access|auth|client)"""),
    "secret:credential_assignment": _rc(r"""[Pp][Aa][Ss][Ss][Ww]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Kk][Ee][Yy]"""),
}


# ---------------------------------------------------------------------------
# Quoted values with spaces, and numbers, under a secret key. Same as
# findQuotedKv in packages/zn-gate/lib/scrub/patterns.js (the Node.js
# scrubber): the credential rules above read one word, so
# `"password":"abcdefgh ijk lmn"` and `{"token":12345678}` were left in the
# clear. Two kinds of value are redacted:
#   - a quoted value that has whitespace in it, up to its closing quote: a
#     double-quoted value ends at the first quote that is not escaped, a
#     single-quoted one at the next ', and a value inside an escaped JSON
#     string at its own escaped quote;
#   - a bare number of 8 or more characters under a QUOTED key. The
#     replacement is written as a string, so the JSON stays valid. A number
#     under an unquoted key (YAML, shell) is left alone.
# Values shorter than 8 characters, placeholders and values with no closing
# quote inside _KV_MAX_VALUE characters are left alone. One pass over the
# text, and each opener reads at most _KV_MAX_VALUE characters.
# ---------------------------------------------------------------------------
_KV_OPEN_RE = _rc(
    r"""(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)"""
    r"""(\\{0,2}["'])?[ \t]{0,16}(?:=>|:=|=|:)[ \t]{0,16}(\\{0,2}["'])?""",
    re.IGNORECASE | re.ASCII)
_KV_PREFILTER_RE = _rc(r"""pass|secret|token|api[_-]?key|access[_-]?key|private[_-]?key""", re.IGNORECASE | re.ASCII)
_KV_MAX_VALUE = 4096
_KV_MIN_VALUE = 8
_KV_NUMBER_RE = _rc(r"""-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?""")
_KV_MASK_RE = _rc(r"""-?([0-9])\1+""")
_KV_WORD_CHAR_RE = _rc(r"""[A-Za-z0-9_.-]""")
_KV_WORD_RUN_RE = _rc(r"""[A-Za-z0-9_.-]*""")
_KV_BACKSLASH_RE = _rc(r"""\\""")
_KV_BACKSLASH_RUN_RE = _rc(r"""\\+""")
_KV_DQUOTE_SPECIAL_RE = _rc(r"""["\\]""")
# JavaScript's \s: the same set of characters as in the Node.js scrubber.
_KV_SPACE = '\t\n\x0b\x0c\r \xa0  -     　﻿'
_KV_SPACE_RE = _rc('[' + _KV_SPACE + ']')
_KV_AUTH_WORD_RE = _rc('(?:bearer|basic|token)[' + _KV_SPACE + ']+', re.IGNORECASE | re.ASCII)
# A placeholder, or a reference after an auth scheme word ("Bearer ${TOKEN}").
_KV_PLACEHOLDER_RE = _rc(
    r"""(?:x{3,}|\*{3,}|\.{3,}|-+|_+|<[^>]*>|\$\{?[^}]*\}?|\{\{?[^}]*\}?\}|%\(?[a-z_]*\)?s|:[a-z_]+|\[[^\]]*\])""",
    re.IGNORECASE | re.ASCII)
_KV_PLACEHOLDER_WORDS_RE = _rc(
    r"""(?:^|[^a-z])(?:password|passwd|passw0rd|secret|changeme|change_me|example|placeholder|your[_-]?|redacted|dummy|sample|foobar|hunter2|xxxx|todo|insert|replace|mypass|pass(?:word)?123)(?:[^a-z]|$)""",
    re.IGNORECASE | re.ASCII)
_KV_REPEAT_RE = _rc('([^\n\r  ])\\1+')
QUOTED_CREDENTIAL_RULE = "secret:quoted_credential"
_KV_REPLACEMENT = "[REDACTED_SECRET]"


def _kv_bare_placeholder(value: str) -> bool:
    return (_KV_PLACEHOLDER_RE.fullmatch(value) is not None or _KV_PLACEHOLDER_WORDS_RE.search(value) is not None
            or _KV_REPEAT_RE.fullmatch(value) is not None)


def _kv_placeholder(value: str) -> bool:
    if _kv_bare_placeholder(value):
        return True
    m = _KV_AUTH_WORD_RE.match(value)
    return m is not None and _kv_bare_placeholder(value[m.end():])


def _find_quoted_credentials(text: str) -> List[Tuple[int, int, str]]:
    """Spans (start, end, quote) of the values described above. quote is the
    quote that the replacement of a bare number is wrapped in (empty for a
    quoted value, whose own quotes stay)."""
    found: List[Tuple[int, int, str]] = []
    n = len(text)
    pos = 0
    while True:
        m = _KV_OPEN_RE.search(text, pos)
        if m is None:
            break
        after = m.end()
        pos = after
        opener = m.group(3)
        key_quote = m.group(2)
        if opener is None:
            num = _KV_NUMBER_RE.match(text, after)
            # Only a quoted key (a JSON member or a dict entry) counts.
            if not key_quote or num is None or num.end() - after < _KV_MIN_VALUE:
                continue
            end = num.end()
            if end < n and _KV_WORD_CHAR_RE.match(text, end) is not None:
                continue                              # part of a longer word, not a number
            if _KV_MASK_RE.fullmatch(num.group()) is not None:
                continue                              # 00000000: a mask
            found.append((after, end, key_quote))
            pos = end
            continue
        quote = opener[-1]
        level = len(opener) - 1                       # backslashes before the opening quote
        start = after
        limit = min(n, start + _KV_MAX_VALUE)
        end = -1
        i = start
        if level == 0 and quote == '"':
            while True:
                hit = _KV_DQUOTE_SPECIAL_RE.search(text, i, limit)
                if hit is None:
                    break
                if text[hit.start()] == '"':
                    end = hit.start()
                    break
                i = hit.start() + 2                   # a backslash escapes the next character
        elif level == 0:
            end = text.find(quote, i, limit)          # single quote: a backslash is just a character
        else:
            while True:
                hit = _KV_BACKSLASH_RE.search(text, i, limit)
                if hit is None:
                    break
                i = hit.start()
                run_match = _KV_BACKSLASH_RUN_RE.match(text, i)
                assert run_match is not None
                run = run_match.end() - i
                if run == level and text[i + run:i + run + 1] == quote:
                    end = i
                    break
                i += run + 1
        if end < 0:
            continue
        value = text[start:end]
        if _utf16_len(value) < _KV_MIN_VALUE or _KV_SPACE_RE.search(value) is None or _kv_placeholder(value):
            continue
        span_end = end
        if level == 0 and not key_quote:
            # A shell word glued to more quoted pieces ('a b''c') is one value: take them too.
            p = end + 1
            for _ in range(8):
                if p >= n or text[p] not in '"\'':
                    break
                word = _KV_WORD_RUN_RE.match(text, p + 1)
                assert word is not None
                q = word.end()
                if q == p + 1:
                    break
                span_end = q
                p = q + 1
        found.append((start, span_end, ''))
        pos = span_end
    return found


def _redact_quoted_credentials(text: str) -> Tuple[str, List[Dict[str, Any]]]:
    """Redacts the values found by _find_quoted_credentials, on the text and on
    the text without invisible characters (as every other rule)."""
    if not text or _KV_PREFILTER_RE.search(text) is None:
        return text, []
    view = invisible_view(text)
    passes: List[Tuple[str, Optional['array[int]']]] = [(text, None)]
    if view is not None:
        passes.append(view)
    cands: List[Tuple[int, int, str, str]] = []
    # The first pass gives its spans in order and without overlaps, so the spans of
    # that pass a later span overlaps are counted with two binary searches.
    seen_starts: List[int] = []
    seen_ends: List[int] = []
    for hay, mapping in passes:
        for start, end, quote in _find_quoted_credentials(hay):
            s, e = _span_in(mapping, start, end)
            if mapping is None:
                seen_starts.append(s)
                seen_ends.append(e)
            elif bisect.bisect_left(seen_starts, e) - bisect.bisect_right(seen_ends, s) >= 2:
                continue
            cands.append((s, e, QUOTED_CREDENTIAL_RULE, quote + _KV_REPLACEMENT + quote))
    if not cands:
        return text, []
    detections: List[Dict[str, Any]] = []
    edits: List[Tuple[int, int, str]] = []
    for start, end, rule_id, new in _merge_candidates(cands):
        detections.append({"rule": rule_id, "start": start, "end": end})
        edits.append((start, end, new))
    return _apply_edits(text, edits), detections


def _redact_credentials(text: str) -> Tuple[str, List[Dict[str, Any]]]:
    """The quoted values first (the other rules read one word and would leave
    the rest of `"api_key":"abcdefghijkl mno pqr"` behind), then SECRET_PATTERNS
    and the provider formats."""
    if not isinstance(text, str) or not text:
        return text, []
    redacted, first = _redact_quoted_credentials(text)
    redacted, rest = _redact_with(redacted, SECRET_PATTERNS + PROVIDER_SECRET_PATTERNS)
    return redacted, first + rest


def _apply_edits(text: str, edits: List[Tuple[int, int, str]]) -> str:
    """Replaces the (start, end, replacement) spans, in ascending order, in text."""
    parts = []
    last = 0
    for start, end, new in edits:
        parts.append(text[last:start])
        parts.append(new)
        last = end
    parts.append(text[last:])
    return ''.join(parts)


def _span_in(mapping: Optional['array[int]'], start: int, end: int) -> Tuple[int, int]:
    """Span [start, end) of a text without invisible characters, as a span of the
    original text. mapping is None for the original text itself."""
    if mapping is None:
        return start, end
    return mapping[start], (mapping[end - 1] + 1 if end > start else mapping[start])


def _expand_template(template: str, groups: List[Optional[Tuple[int, int]]], text: str) -> str:
    """Replacement template with \\1..\\9 expanded from the group spans of the
    original text (see expandTemplate in rules.js)."""
    def sub(m: "re.Match[str]") -> str:
        g = groups[int(m.group(1))]
        return text[g[0]:g[1]] if g is not None else ''
    return re.sub(r'\\(\d)', sub, template)


def _starts_secret_at(text: str, start: int, limit: int,
                      patterns: List[Tuple[str, re.Pattern[str], str]]) -> bool:
    """True when a rule of `patterns` matches at the first non-space character after `start` (before
    `limit`): the next line starts a secret of its own (see startsSecretAt in rules.js)."""
    pos = start
    while pos < limit and text[pos].isspace():
        pos += 1
    if pos >= limit:
        return False
    return any(p.match(text, pos) for _, p, _ in patterns)


def _rule_candidates(rule_id: str, pattern: re.Pattern[str], replacement: str, text: str,
                     view: Optional[Tuple[str, 'array[int]']], budget: List[int],
                     value_filter: Optional[Callable[[str, str], bool]],
                     out: List[Tuple[int, int, str, str]],
                     match_check: Optional[Callable[[str], bool]] = None,
                     patterns: Optional[List[Tuple[str, re.Pattern[str], str]]] = None) -> None:
    """Candidate redactions of one rule as (start, end, rule_id, replacement) in
    original coordinates. The rule runs on the original text and on the text
    without invisible characters (see ruleCandidates in rules.js). match_check,
    when given, receives the whole match and returns False to skip it."""
    passes: List[Tuple[str, Optional['array[int]'], bool]] = [(text, None, False)]
    # Spans this rule found on the original text; a view match overlapping two or more is dropped
    # (see ruleCandidates in rules.js). They come in order and without overlaps, so the ones a
    # view match overlaps are counted with two binary searches.
    found_starts: List[int] = []
    found_ends: List[int] = []
    if view is not None:
        passes.append((view[0], view[1], False))
        # A third pass reads each invisible character as a space; its indexes are the original ones.
        spaced = _spaced_view(text)
        if spaced != text:
            passes.append((spaced, None, True))
    for hay, mapping, is_spaced in passes:
        required = SECRET_PATTERN_REQUIRES.get(rule_id)
        if required and required not in hay:
            continue
        hints = PROVIDER_HINTS.get(rule_id)
        if hints and not any(h in hay for h in hints):
            continue
        prefilter = SECRET_PATTERN_PREFILTERS.get(rule_id) or SCAN_SECRET_PREFILTERS.get(rule_id)
        if prefilter is not None and not prefilter.search(hay):
            continue
        for m in pattern.finditer(hay):
            if m.end() == m.start():
                continue
            if match_check is not None and not match_check(m.group(0)):
                continue
            groups: List[Optional[Tuple[int, int]]] = [None]
            for k in range(1, pattern.groups + 1):
                if m.start(k) == -1:
                    groups.append(None)
                else:
                    groups.append(_span_in(mapping, m.start(k), m.end(k)))
            if value_filter is not None:
                # The value (group 2) decides whether the match is redacted.
                span = groups[2]
                assert span is not None
                vs, ve = span
                value = _clean_value(text[vs:ve])
                prefix = ''
                if groups[1] is not None:
                    prefix = _clean_value(text[groups[1][0]:groups[1][1]])
                n = _utf16_len(value)
                if n <= MAX_FILTERED_VALUE and n <= budget[0]:
                    budget[0] -= n
                    if value_filter(value, prefix):
                        continue
            start, end = _span_in(mapping, m.start(), m.end())
            if is_spaced:
                pass  # same indexes as the original: it cannot join two matches, and it is not in order
            elif mapping is None:
                found_starts.append(start)
                found_ends.append(end)
            else:
                first = bisect.bisect_right(found_ends, start)
                over = bisect.bisect_left(found_starts, end) - first
                if over >= 2:
                    continue
                if over == 1 and patterns and _starts_secret_at(text, found_ends[first], end, patterns):
                    continue
            out.append((start, end, rule_id, _expand_template(replacement, groups, text)))


def _merge_candidates(cands: List[Tuple[int, int, str, str]]) -> List[Tuple[int, int, str, str]]:
    """Overlapping candidates become one redaction covering their union; the first
    candidate (earliest start, then longest) supplies the replacement text."""
    cands.sort(key=lambda c: (c[0], -c[1]))
    merged: List[Tuple[int, int, str, str]] = []
    for c in cands:
        if merged and c[0] < merged[-1][1]:
            last = merged[-1]
            if c[1] > last[1]:
                merged[-1] = (last[0], c[1], last[2], last[3])
            continue
        merged.append(c)
    return merged


def redact_secrets(text: str) -> Tuple[str, List[Dict[str, Any]]]:
    """
    Scans a text for sensitive credentials (API keys, private keys, passwords)
    and redacts them in place. Returns (redacted_text, detected_secrets_list).
    Every rule runs on the original text and on the text without invisible
    characters; the redacted spans are the union of both (see redactSecrets in
    rules.js).
    """
    return _redact_credentials(text)


def redact_scan_secrets(text: str) -> Tuple[str, List[Dict[str, Any]]]:
    """redact_secrets plus SCAN_SECRET_PATTERNS, for `zn-gate scan`: the scan
    rules run on the text redact_secrets already redacted (redactScanSecrets in
    rules.js, with the provider formats in between as the Node.js scan does)."""
    redacted, first = _redact_credentials(text)
    redacted, second = _redact_with(redacted, SCAN_SECRET_PATTERNS)
    return redacted, first + second


def _redact_with(text: str, patterns: List[Tuple[str, re.Pattern[str], str]]) -> Tuple[str, List[Dict[str, Any]]]:
    if not isinstance(text, str) or not text:
        return text, []

    redacted = text
    detections: List[Dict[str, Any]] = []
    budget = [MAX_FILTERED_CHARS]
    view = None
    dirty = True

    for rule_id, pattern, replacement in patterns:
        if dirty:
            view = invisible_view(redacted)
            dirty = False
        cands: List[Tuple[int, int, str, str]] = []
        value_filter = (SECRET_VALUE_FILTERS.get(rule_id) or PROVIDER_VALUE_FILTERS.get(rule_id)
                        or SCAN_SECRET_VALUE_FILTERS.get(rule_id))
        _rule_candidates(rule_id, pattern, replacement, redacted, view, budget,
                         value_filter, cands, PROVIDER_MATCH_CHECKS.get(rule_id), patterns)
        if not cands:
            continue
        edits: List[Tuple[int, int, str]] = []
        for start, end, found_rule, new in _merge_candidates(cands):
            detections.append({"rule": found_rule, "start": start, "end": end})
            edits.append((start, end, new))
        redacted = _apply_edits(redacted, edits)
        dirty = True

    return redacted, detections


# Display defence in depth, applied after redact_secrets to snippets, CLI
# output and the ledger preview: a run of 24 or more token characters that
# holds both a letter and a digit is masked, so a credential format the table
# above does not know does not reach a terminal, a CI log or the ledger. A UUID
# is kept (an identifier, not a credential); a 64-hex digest is masked.
_TOKEN_RUN_RE = _rc(r'[A-Za-z0-9_\-+/=]{24,}')
_UUID_FULL_RE = _rc(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
_UUID_RE = _rc(r'(?<![0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z])')
_RUN_SEP_RE = _rc(r'[-_/]+')
# One part of an identifier: a word (lower, Capitalized or camelCase) with an
# optional short number, or a short number.
_WORDY_PART_RE = _rc(r'(?:[A-Z]+\d{0,4}|[A-Za-z][a-z]*(?:[A-Z][a-z]+)*[A-Z]?\d{0,4}|\d{1,4})?')


def _wordy_run(run: str) -> bool:
    """True for names, paths and identifiers such as test_case_v2, MAX_SIZE_2048,
    ../components/Header2/indexFile or user-<uuid>: every part between - _ /
    is a word or a short number."""
    if _RUN_SEP_RE.search(run) is None:
        return False
    parts = _RUN_SEP_RE.split(_UUID_RE.sub("uuid", run))
    return all(_WORDY_PART_RE.fullmatch(p) for p in parts)


def mask_token_runs(text: str) -> str:
    """Masks token-like runs left in a text that was already passed through redact_secrets."""
    if not text:
        return text

    def _sub(m: "re.Match[str]") -> str:
        run = m.group(0)
        if _TOKEN_ALPHA_RE.search(run) is None or _DIGIT_RE.search(run) is None:
            return run
        if _UUID_FULL_RE.fullmatch(run) or _wordy_run(run):
            return run
        return "[REDACTED_TOKEN]"

    return _TOKEN_RUN_RE.sub(_sub, text)

# Tool output can be large (file reads, search results). Instead of the
# head + tail view used by evaluate(), it is scanned in windows of
# MAX_SCAN_CHARS that overlap by SCAN_WINDOW_OVERLAP, so a payload in the
# middle is not skipped. Past MAX_TOOL_RESULT_SCAN_CHARS only the last window
# is added and the result is marked truncated=True. A match that spans more
# than SCAN_WINDOW_OVERLAP characters across a window boundary can be missed.
SCAN_WINDOW_OVERLAP = 4 * 1024
MAX_TOOL_RESULT_SCAN_CHARS = 4 * 1024 * 1024


# Tool output that is mostly invisible characters is blocked, not scanned: see
# tooInvisible in rules.js. Counted in code points over every string of a result.
MIN_INVISIBLE_CHECK_CHARS = 64 * 1024
MAX_INVISIBLE_CHARS = 200000
INVISIBLE_BLOCK_REASON = 'Output is mostly invisible characters'
_SUBDIVISION_FLAG_RE = _rc('\U0001F3F4[\U000E0030-\U000E0039\U000E0061-\U000E007A]{2,7}\U000E007F')


def too_invisible(strings: Any) -> bool:
    count = 0
    length = 0
    step = 1 << 20
    for text in strings:
        if not isinstance(text, str):
            continue
        length += len(text)
        for i in range(0, len(text), step):
            chunk = text[i:i + step]
            flags = len(_SUBDIVISION_FLAG_RE.findall(chunk))
            if flags:
                chunk = _SUBDIVISION_FLAG_RE.sub('\U0001F3F4', chunk)
            count += flags + len(chunk) - len(INVISIBLE_ASTRAL_RE.sub('', ZERO_WIDTH_RE.sub('', chunk)))
            if count > MAX_INVISIBLE_CHARS:
                return True
    return length >= MIN_INVISIBLE_CHECK_CHARS and count * 2 > length


def invisible_block() -> Assessment:
    return Assessment(verdict='block', confidence=1.0, rule='size:invisible', reason=INVISIBLE_BLOCK_REASON)


def truncated_blocks(block_truncated: bool = False, allow_truncated: bool = False) -> bool:
    """True when a result whose middle was not scanned must be blocked.

    Blocked by default. allow_truncated=True or ZN_ALLOW_TRUNCATED=1 opts out;
    block_truncated=True or ZN_BLOCK_TRUNCATED=1 (the former opt-in) still
    forces the block and wins over the opt-out.
    """
    if block_truncated or env_flag('ZN_BLOCK_TRUNCATED'):
        return True
    return not (allow_truncated or env_flag('ZN_ALLOW_TRUNCATED'))


def scan_windows(text: str, strict: Optional[bool] = None) -> Assessment:
    strict = _strict(strict)
    if too_invisible([text]):
        return invisible_block()
    text = _collapse_blank_runs(text)
    if not isinstance(text, str) or len(text) <= MAX_SCAN_CHARS:
        return evaluate(text, strict=strict)
    step = MAX_SCAN_CHARS - SCAN_WINDOW_OVERLAP
    limit = min(len(text), MAX_TOOL_RESULT_SCAN_CHARS)
    start = 0
    advisory = None
    while True:
        end = min(start + MAX_SCAN_CHARS, limit)
        res = _evaluate_uncached(text[start:end], strict)
        if advisory is None and res.advisory:
            advisory = res.advisory
        if not res.allowed or end >= limit:
            break
        start += step
    if res.allowed and len(text) > limit:
        res = _evaluate_uncached(text[-MAX_SCAN_CHARS:], strict)
        if advisory is None and res.advisory:
            advisory = res.advisory
    if res.allowed and advisory:
        res.advisory = dict(advisory)
    res.truncated = len(text) > limit
    return res


class SanitizedToolResult(TypedDict):
    """Result of sanitize_tool_result(tool_name, content)."""
    tool_name: str
    safe_to_ingest: bool
    truncated: bool
    assessment: Assessment
    secrets_redacted: int
    sanitized_content: str


# Limits of the deep-data form of sanitize_tool_result, the same as the walker of
# the guard (guard._DEFAULT_MAX_DEPTH and guard.MAX_OBJECT_VALUES): ten levels of
# dicts, lists, tuples and sets, and 100,000 values in all.
SANITIZE_MAX_DEPTH = 10
SANITIZE_MAX_ITEMS = 100_000


class SanitizeLimitError(ValueError):
    """Raised by sanitize_tool_result(data) for data it will not walk to mask: nested deeper
    than SANITIZE_MAX_DEPTH levels, a container that contains itself (rule size:nesting) or
    more than SANITIZE_MAX_ITEMS values (rule size:items)."""

    def __init__(self, rule: str, reason: str):
        super().__init__(reason)
        self.rule = rule
        self.reason = reason


@overload
def sanitize_tool_result(
    tool_or_result: Any,
    content: None = None,
    mask_secrets: bool = True,
    block_truncated: bool = False,
    strict: Optional[bool] = None,
    allow_truncated: bool = False,
) -> Tuple[Any, List[Dict[str, Any]]]: ...


@overload
def sanitize_tool_result(
    tool_or_result: Any,
    content: Any,
    mask_secrets: bool = True,
    block_truncated: bool = False,
    strict: Optional[bool] = None,
    allow_truncated: bool = False,
) -> SanitizedToolResult: ...


def sanitize_tool_result(
    tool_or_result: Any,
    content: Optional[Any] = None,
    mask_secrets: bool = True,
    block_truncated: bool = False,
    strict: Optional[bool] = None,
    allow_truncated: bool = False,
) -> Any:
    """
    Sanitizes tool output to prevent prompt injection and credential leakage.
    Can be called as:
      1) sanitize_tool_result(data) -> returns (clean_data, detections)
      2) sanitize_tool_result(tool_name, content, mask_secrets=True) -> returns dict with
         {tool_name, safe_to_ingest, truncated, assessment, secrets_redacted, sanitized_content}
    In form 1, data nested deeper than ten levels, a container that contains itself
    or more than 100,000 values raises SanitizeLimitError (a ValueError with the
    attributes rule, "size:nesting" or "size:items", and reason) instead of
    exhausting the stack.
    In form 2, content that is not a string (a dict, list or object) is checked
    string by string, as check_tool_result does, and as JSON text;
    sanitized_content is that JSON text (as in Node.js), with secrets masked.
    Tool output longer than MAX_TOOL_RESULT_SCAN_CHARS is not fully analysed:
    `truncated` is then True, and the output is blocked (rule size:truncated)
    unless allow_truncated is set or the ZN_ALLOW_TRUNCATED environment variable
    is "1". block_truncated and ZN_BLOCK_TRUNCATED=1 force the block.
    """
    if content is not None:
        tool_name = str(tool_or_result)
        if isinstance(content, str):
            text_content = content
            assessment = scan_windows(text_content, strict=strict)
        else:
            # Structured output: check every real string value (keys and object
            # attributes included) as check_tool_result does, then the JSON text
            # as Node.js does. str() would escape BiDi and zero-width characters.
            from .guard import check_tool_result
            try:
                text_content = json.dumps(content, ensure_ascii=False, default=str)
            except (TypeError, ValueError, RecursionError):
                text_content = str(content)
            # The JSON text holds every string of the output: count the invisible
            # characters before the string-by-string check pays for them.
            assessment = invisible_block() if too_invisible([text_content]) else check_tool_result(content, strict=strict, allow_truncated=True)
            if assessment.allowed:
                text_assessment = scan_windows(text_content, strict=strict)
                if not text_assessment.allowed:
                    assessment = text_assessment
                else:
                    assessment.truncated = assessment.truncated or text_assessment.truncated
        truncated = assessment.truncated
        if truncated and assessment.allowed and truncated_blocks(block_truncated, allow_truncated):
            assessment = Assessment(verdict='block', confidence=1.0, rule='size:truncated',
                                    reason='Output too large to scan in full', truncated=True)
        is_block = not assessment.allowed

        if is_block:
            sanitized = f"[REDACTED BY ZN-GATE: Malicious prompt injection payload detected in {tool_name} output ({assessment.reason or assessment.rule})]"
            secrets_redacted = 0
        else:
            if mask_secrets:
                sanitized, det = redact_secrets(text_content)
                secrets_redacted = len(det)
            else:
                sanitized = text_content
                secrets_redacted = 0

        return {
            "tool_name": tool_name,
            "safe_to_ingest": not is_block,
            "truncated": truncated,
            "assessment": assessment,
            "secrets_redacted": secrets_redacted,
            "sanitized_content": sanitized,
        }

    # Deep data structure sanitization
    detections: List[Dict[str, Any]] = []

    def _unique_name(name: str, taken: set[Any]) -> str:
        """Return `name`, or `name #N`, whichever is not taken yet, and take it."""
        base = name
        n = 2
        while name in taken:
            name = f"{base} #{n}"
            n += 1
        taken.add(name)
        return name

    def _unique_member(member: Any, taken: set[Any]) -> Any:
        """Like _unique_name for a set member: a masked tuple that collides gets its first text part numbered."""
        if isinstance(member, str):
            return _unique_name(member, taken)
        if isinstance(member, tuple) and member in taken:
            idx = next((i for i, p in enumerate(member) if isinstance(p, str)), None)
            if idx is not None:
                base = member[idx]
                n = 2
                cand = member
                while cand in taken:
                    cand = member[:idx] + (f"{base} #{n}",) + member[idx + 1:]
                    n += 1
                member = cand
        taken.add(member)
        return member

    def _sanitize_members(members: Any) -> List[Any]:
        """Sanitize set members; masked members that become equal stay apart."""
        originals = list(members)
        cleaned = [_sanitize(m) for m in originals]
        taken = {c for c, m in zip(cleaned, originals, strict=True) if c == m}
        out: List[Any] = []
        for c, m in zip(cleaned, originals, strict=True):
            if c != m:
                c = _unique_member(c, taken)
            out.append(c)
        return out

    path: set[int] = set()
    budget = [SANITIZE_MAX_ITEMS]

    def _enter(val: Any) -> None:
        """Take one level for the container `val`, or raise SanitizeLimitError."""
        if id(val) in path:
            raise SanitizeLimitError("size:nesting", "The data contains itself")
        if len(path) >= SANITIZE_MAX_DEPTH:
            raise SanitizeLimitError("size:nesting", "The data is nested too deeply to mask")
        budget[0] -= len(val) * 2 if isinstance(val, dict) else len(val)
        if budget[0] < 0:
            raise SanitizeLimitError("size:items", "The data holds too many values to mask")
        path.add(id(val))

    def _sanitize(val: Any) -> Any:
        if not isinstance(val, (dict, list, tuple, set, frozenset)):
            return _sanitize_value(val)
        _enter(val)
        try:
            return _sanitize_value(val)
        finally:
            path.discard(id(val))

    def _sanitize_value(val: Any) -> Any:
        if isinstance(val, str):
            clean_str, det = redact_secrets(val)
            if det:
                detections.extend(det)
            return clean_str
        elif isinstance(val, dict):
            items = list(val.items())
            names = [_sanitize(k) if isinstance(k, str) else k for k in [k for k, _ in items]]
            taken = {n for n, (k, _) in zip(names, items, strict=True) if n == k}
            out: Dict[Any, Any] = {}
            for name, (key, v) in zip(names, items, strict=True):
                if name != key:
                    name = _unique_name(name, taken)
                out[name] = _sanitize(v)
            return out
        elif isinstance(val, list):
            return [_sanitize(v) for v in val]
        elif isinstance(val, tuple):
            return tuple(_sanitize(v) for v in val)
        elif isinstance(val, frozenset):
            return frozenset(_sanitize_members(val))
        elif isinstance(val, set):
            return set(_sanitize_members(val))
        return val

    sanitized = _sanitize(tool_or_result)
    return sanitized, detections



_EVAL_CACHE_MAX = 2048
# Only inputs up to 8 KB are cached, so the cache itself stays small.
EVAL_CACHE_MAX_INPUT = 8 * 1024
_eval_cache: Dict[Tuple[bool, str], Tuple[Any, ...]] = {}
_eval_cache_ver = RULES_VERSION


# Marks an argument that was not passed, so evaluate(None) keeps its old answer.
_NOT_GIVEN: Any = object()


def evaluate(text: Optional[str] = _NOT_GIVEN, strict: Optional[bool] = None, *,
             input_text: Optional[str] = _NOT_GIVEN) -> Assessment:
    """Cached entry point: LRU(2048) keyed on raw input and strict mode, version-guarded.

    The text goes first or as text=...; input_text=... is the older keyword
    name and still works. strict=True (or ZN_STRICT=1) also blocks the
    heuristic rules that are advisories by default (ADVISORY_BY_DEFAULT)."""
    global _eval_cache_ver
    if input_text is not _NOT_GIVEN:
        if text is not _NOT_GIVEN:
            raise TypeError("evaluate() takes the text once: pass text or input_text, not both")
        text = input_text
    elif text is _NOT_GIVEN:
        raise TypeError("evaluate() missing the text to check")
    # None is not a str but keeps its old answer (the check below handles it).
    input_text = cast(str, text)
    strict = _strict(strict)
    if not isinstance(input_text, str) or len(input_text) > EVAL_CACHE_MAX_INPUT:
        return _evaluate_uncached(input_text, strict)
    if RULES_VERSION != _eval_cache_ver:
        _eval_cache.clear()
        _eval_cache_ver = RULES_VERSION
    key = (strict, input_text)
    hit = _eval_cache.get(key)
    if hit is not None:
        _eval_cache[key] = _eval_cache.pop(key)
        return Assessment(hit[0], hit[1], hit[2], hit[3], hit[4], hit[5], hit[6], advisory=dict(hit[7]) if hit[7] else None)
    res = _evaluate_uncached(input_text, strict)
    _eval_cache[key] = (res.verdict, res.confidence, res.rule,
                               res.reason, res.engine, res.rules_version, res.truncated,
                               dict(res.advisory) if res.advisory else None)
    if len(_eval_cache) > _EVAL_CACHE_MAX:
        _eval_cache.pop(next(iter(_eval_cache)))
    return res


# Third-party notice for the provider formats marked as taken from gitleaks v8.30.1 (config/gitleaks.toml):
#
# MIT License
#
# Copyright (c) 2019 Zachary Rice
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
