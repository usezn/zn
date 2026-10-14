"""
zn deterministic rules engine - Python stdlib implementation.
RULES_VERSION: 2026-10-14.1
Zero external dependencies. Pure Python stdlib.
"""

from __future__ import annotations

import base64
import json
from array import array
import math
import os
import re
import sys
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple

RULES_VERSION = "2026-10-14.3"

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
ZERO_WIDTH_RE = re.compile(r'[\u200B-\u200D\u2060\uFEFF\u00AD\uFE00-\uFE0F]')
INVISIBLE_ASTRAL_RE = re.compile(r'[\U000E0000-\U000E007F\U000E0100-\U000E01EF]')
NON_ASCII_RE = re.compile(r'[^\x00-\x7f]')
ANSI_ESCAPE_RE = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*\x07')
B64_EXEC_RE = re.compile(r'(?:echo|printf)\s+([A-Za-z0-9+/=]{16,})\s*\|\s*(?:base64\s+-(?:d|-decode)|openssl)', re.IGNORECASE)
# Maximal whitespace runs; only runs that contain a line break are joined.
# A pattern anchored on the line break (such as [^\S\r\n]*[\r\n]) would rescan
# a long run of spaces from every position.
WHITESPACE_RUN_RE = re.compile(r'\s+')
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
RU_FORGET_RE = re.compile(r'забудь\s+', re.IGNORECASE)
RU_FORGET_OBJECT_RE = re.compile(r'все|инструкции', re.IGNORECASE)
RU_IGNORE_RE = re.compile(r'игнорируй\s+', re.IGNORECASE)
RU_IGNORE_OBJECT_RE = re.compile(r'все|предыдущие', re.IGNORECASE)
RU_PHRASE_RE = re.compile(r'действуй\s+как|ты\s+теперь|найди\s+пароли', re.IGNORECASE)
ZH_IGNORE_RE = re.compile(r'忽略')
ZH_IGNORE_OBJECT_RE = re.compile(r'指示|指令|提示')
ZH_FORGET_RE = re.compile(r'忘记')
ZH_FORGET_OBJECT_RE = re.compile(r'指示|指令|一切')
ZH_PHRASE_RE = re.compile(r'你现在是|初始提示词')


def _near_match(text: str, verb_re: re.Pattern, object_re: re.Pattern) -> bool:
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


INJECTION_RULES: List[Tuple[str, re.Pattern, str]] = [
    ('pi:ignore_previous', re.compile(_override_rule_source('ignore'), re.IGNORECASE), 'Override prior instructions'),
    ('pi:disregard', re.compile(_override_rule_source('disregard'), re.IGNORECASE), 'Disregard instructions'),
    ('pi:forget', re.compile(r"""(?<![A-Za-z0-9_])forget\s+(?:about\s+)?(?:everything|all|your)(?![A-Za-z0-9_])(?!\s+(?:of\s+)?(?:the\s+)?(?:cached?|caches|entries|changes|data|files?|records|sessions?|cookies|state|tabs|devices?|passwords?|history|items|keys|tokens|credentials|settings|preferences|accounts?|connections?|logins?|networks?)(?![A-Za-z0-9_]))""", re.IGNORECASE), 'Forget-context attack'),
    ('pi:identity_override', re.compile(r'you\s+are\s+now', re.IGNORECASE), 'Identity override'),
    ('pi:new_instructions', re.compile(r'new\s+instructions?:', re.IGNORECASE), 'Instruction replacement'),
    ('pi:system_tag', re.compile(r"""(?:^|[\r\n"'`\[<])[ \t]*system\s*:|<[\s/]*system(?![A-Za-z0-9_])[^<>]*>""", re.IGNORECASE), 'Fake system tag'),
    ('pi:system_bracket', re.compile(r'\[system\]', re.IGNORECASE), 'Bracketed system tag'),
    ('pi:act_as', re.compile(r"""(?:(?<![A-Za-z0-9_])you\s+(?:(?:will|must|should|shall|now)\s+|are\s+to\s+)?|(?:^|[.!?\r\n\u2028\u2029])[ \t]*(?:[\"'`(\[*-][ \t]*)?|(?<![A-Za-z0-9_])please\s+|(?<![A-Za-z0-9_])now\s+|(?<![A-Za-z0-9_])from\s+now\s+on,?\s+(?:you\s+)?)(?=act(?![A-Za-z0-9_]))act\s+as\s+(?:if\s+you(?![A-Za-z0-9_])|an?\s+(?:[a-z-]+\s+){0,3}?(?:ai|assistant|chatbot|bot|model|llm|gpt|persona|character|version|mode|jailbroken|unrestricted|unfiltered|uncensored|evil|malicious|rogue|harmful|unethical|amoral|hacker|dan)(?![A-Za-z0-9_])|my(?![A-Za-z0-9_])|though\s+you(?![A-Za-z0-9_]))""", re.IGNORECASE), 'Role hijack (act as)'),
    ('pi:pretend', re.compile(r'pretend\s+(you|to\s+be)', re.IGNORECASE), 'Role hijack (pretend)'),
    ('pi:roleplay', re.compile(r'roleplay\s+as', re.IGNORECASE), 'Role hijack (roleplay)'),
    ('pi:jailbreak', re.compile(r'(?<![A-Za-z0-9_])jailbreak(?![A-Za-z0-9_])', re.IGNORECASE), 'Explicit jailbreak term'),
    ('pi:bypass', re.compile(r'bypass\s+(your|the|all)', re.IGNORECASE), 'Guardrail bypass attempt'),
    ('pi:override', re.compile(r'(?<![A-Za-z0-9_])override\s+(?:all\s+|your\s+|the\s+)?(?:system|policy|safety|rules|instructions|guidelines|restrictions)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])system\s+override\s*:', re.IGNORECASE), 'Policy override attempt'),
    ('pi:template_boundary', re.compile(r'\[INST\]|\[\/INST\]|<<<SYS>>>|<\/<<SYS>>>|<\|im_start\|>|<\|im_end\|>', re.IGNORECASE), 'Chat template boundary injection'),
    ('pi:multi_es', re.compile(r'ignora\s+(todas\s+las\s+)?(instrucciones|anteriores|previas)|olvida\s+(todo|las\s+instrucciones)|act[uú]a\s+como|ahora\s+eres', re.IGNORECASE), 'Multilingual prompt injection (Spanish)'),
    ('pi:multi_pt', re.compile(r'ignor(?:e|a|em|ar)\s+(?:(?:todas|todos|qualquer|quaisquer|cualquier)\s+)?(?:(?:as|os|las|los|suas|seus|sus|tus|estas|estes|essas|esses)\s+)?(?:instru[cç][oõ]es|instrucciones|regras|reglas|diretrizes|directrices|orienta[cç][oõ]es|ordens|[oó]rdenes|comandos|restri[cç][oõ]es|restricciones|mensagens|anteriores|pr[eé]vias)|ignore\s+(?:tudo|qualquer|quaisquer)(?![A-Za-z0-9_])|ignora\s+(?:todo|tudo|cualquier)(?![A-Za-z0-9_])', re.IGNORECASE), 'Multilingual prompt injection (Portuguese)'),
    ('pi:multi_fr', re.compile(r'ignore[rz]?\s+(toutes\s+les\s+)?instructions|oublie[rz]?\s+tout|agis\s+comme|tu\s+es\s+maintenant', re.IGNORECASE), 'Multilingual prompt injection (French)'),
    ('pi:multi_de', re.compile(r'ignoriere\s+(alle\s+)?(anweisungen|instruktionen)|vergiss\s+(alles|jede)|du\s+bist\s+jetzt|handle\s+als', re.IGNORECASE), 'Multilingual prompt injection (German)'),
    ('pi:multi_ru', re.compile(r'забудь\s+[^\n]{0,80}?(все|инструкции)|игнорируй\s+[^\n]{0,80}?(все|предыдущие)|действуй\s+как|ты\s+теперь|найди\s+пароли', re.IGNORECASE), 'Multilingual prompt injection (Russian)'),
    ('pi:multi_zh', re.compile(r'忽略[^\n]{0,80}?(指示|指令|提示)|忘记[^\n]{0,80}?(指示|指令|一切)|你现在是|初始提示词'), 'Multilingual prompt injection (Chinese)'),
]

EVASION_RULES: List[Tuple[str, re.Pattern, str]] = [
    (
        'evasion:bidi_override',
        re.compile(r'[\u202A-\u202E\u2066-\u2069]'),
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
OPEN_TAG_RE = re.compile(r'<[a-z0-9]+(?![A-Za-z0-9_])([^<>]*)(>?)', re.IGNORECASE)
HIDDEN_ATTR_RE = re.compile(r'(?<![A-Za-z0-9_])(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0(?:px)?|color\s*:\s*transparent|text-indent\s*:\s*-[0-9]{3,}px|hidden(?![A-Za-z0-9_]))', re.IGNORECASE)
HIDDEN_PAYLOAD_RE = re.compile(r'ignore|system|instruction|prompt|bypass|override|exfil|leak', re.IGNORECASE)


# The payload must be in the text of the hidden element itself: its content
# up to the matching close tag (nested tags removed), at most
# HIDDEN_TEXT_CHARS characters after the opening tag. Text after the element
# does not count.
HIDDEN_TEXT_CHARS = 4096
TAG_RE = re.compile(r'<(/?)([a-z0-9]+)(?![A-Za-z0-9_])[^<>]*>', re.IGNORECASE)
_TAG_NAME_RE = re.compile(r'<([a-z0-9]+)', re.IGNORECASE)


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
        if m.group(2) == '>' and HIDDEN_ATTR_RE.search(m.group(1)):
            name = _TAG_NAME_RE.match(m.group(0)).group(1).lower()
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
        if m.group(2) == '>' and HIDDEN_ATTR_RE.search(m.group(1)):
            return HIDDEN_PAYLOAD_RE.search(text, m.end()) is not None
    return False


INDIRECT_INJECTION_RULES: List[Tuple[str, re.Pattern, str]] = [
    (
        'indirect:html_comment',
        re.compile(r'<!--\s*(?:system|instruction|prompt|override|command)\s*:', re.IGNORECASE),
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
MD_IMAGE_RE = re.compile(r'!\[[^\]]*(?:\]\(([^\s)]*))?', re.IGNORECASE)
MD_URL_SCHEME_RE = re.compile(r'^https?:\/\/[^?&]', re.IGNORECASE)
MD_URL_SECRET_PARAM_RE = re.compile(r'[?&](?:key|token|pass|secret|cred|data|val|leak|exfil)=', re.IGNORECASE)


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


# Rules whose match is computed by a function instead of pattern.search().
RULE_TESTERS: Dict[str, Any] = {
    'indirect:hidden_tag': _test_hidden_tag,
    'exfil:markdown_image': _test_markdown_image,
    'pi:multi_ru': _test_multi_ru,
    'pi:multi_zh': _test_multi_zh,
}

EXFIL_VERB_SOURCE = r'(?<![A-Za-z0-9_])(give|reveal|send|show|print|expose|leak|paste|dump|read|open|cat|fetch|extract|steal)(?![A-Za-z0-9_])'
EXFIL_VERBS = re.compile(EXFIL_VERB_SOURCE, re.IGNORECASE)
CRED_OBJECTS = re.compile(r"""(?<![A-Za-z0-9_])(passwords?|api[_ -]?keys?|secrets?|credentials?|tokens?|ssh[ _-]?keys?|private[ _-]?keys?|aws_secret[a-z0-9_]*|aws_access[a-z0-9_]*)(?![A-Za-z0-9_])|(?:^|\s|['"`])\.env(?:\.[a-z0-9]+)?(?![A-Za-z0-9_])""", re.IGNORECASE)

# The verb must start a clause (an instruction, not a description such as
# "this library reads tokens from ...") or be followed by "me"/"us", and the
# credential must follow it in the same clause, within EXFIL_CLAUSE_CHARS
# characters. No MULTILINE flag: line starts are matched by the newline
# itself, so a run of blank lines is read once.
EXFIL_CLAUSE_CHARS = 80
EXFIL_CLAUSE_PREFIX = r"""(?:^|[.!?;:\r\n\u2028\u2029])[ \t]*(?:[\"'`(\[*-][ \t]*)?|(?<![A-Za-z0-9_])(?:please|now|then|and|also|just|first|immediately|go\s+ahead\s+and|(?:can|could|would|will)\s+you|(?:want|need|ask)\s+you\s+to|you\s+(?:must|should|will|need\s+to|have\s+to))\s+"""
EXFIL_CLAUSE_RE = re.compile(
    r'(?:(?:' + EXFIL_CLAUSE_PREFIX + r')' + EXFIL_VERB_SOURCE + r'|' + EXFIL_VERB_SOURCE + r'(?=\s+(?:me|us)(?![A-Za-z0-9_])))'
    + r'[^.!?;\r\n]{0,' + str(EXFIL_CLAUSE_CHARS) + r'}?(?:' + CRED_OBJECTS.pattern + r')',
    re.IGNORECASE,
)

# Advisory tier: the broader forms of four rules. They match much benign
# text (documentation, code, role-play requests), so a match does not block:
# the verdict stays "allow" and the result carries `advisory` with the rule.
# A blocking rule always wins over an advisory.
ADVISORY_RULES: List[Tuple[str, Any, str]] = [
    ('exfil:credentials', lambda t: EXFIL_VERBS.search(t) is not None and CRED_OBJECTS.search(t) is not None, 'Mentions reading or sending credentials'),
    ('pi:act_as', re.compile(r'act\s+as\s+(?:if|a)', re.IGNORECASE).search, 'Role-play request (act as)'),
    ('pi:forget', re.compile(r'forget\s+(?:about\s+)?(?:everything|all|your)', re.IGNORECASE).search, 'Asks to forget context'),
    ('indirect:hidden_tag', _test_hidden_tag_anywhere, 'Hidden element in markup followed by instruction-like words'),
]

SENSITIVE_PATH_RULES: List[Tuple[str, re.Pattern, str]] = [
    (
        'path:sensitive_file',
        re.compile(r"""(?:^|[\s"'`(\[])(?:~|\/home\/[^\s/]+|\/root)?\/?\.(?:ssh\/(?:id_rsa|id_ed25519|authorized_keys)|aws\/credentials|env(?:\.[a-z0-9]+)?)(?![A-Za-z0-9_])|\/etc\/(?:shadow|passwd)(?![A-Za-z0-9_])""", re.IGNORECASE),
        'Targeting sensitive system credentials or environment file',
    ),
]

MARKDOWN_EXFIL_RULES: List[Tuple[str, re.Pattern, str]] = [
    (
        'exfil:markdown_image',
        # The pattern is the linear image scanner; the rule is _test_markdown_image().
        MD_IMAGE_RE,
        'Covert exfiltration via markdown image URL parameter',
    ),
]

# evaluate() analyses inputs longer than MAX_SCAN_CHARS as head + tail and
# marks the result truncated=True. Tool results are scanned in overlapping
# windows (up to MAX_TOOL_RESULT_SCAN_CHARS) by scan_windows() below. Lengths count code points here and UTF-16 code
# units in Node.js; the two only differ for characters outside the BMP.
MAX_SCAN_CHARS = 256 * 1024
SCAN_HEAD_CHARS = 192 * 1024
# One character is reserved for the separator, so the window fits the limit.
SCAN_TAIL_CHARS = MAX_SCAN_CHARS - SCAN_HEAD_CHARS - 1

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


def _join_line_break(m: Any) -> str:
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


def _strip_invisible(text: str) -> str:
    """Removes invisible characters (zero-width, variation selectors, tag characters)."""
    return INVISIBLE_ASTRAL_RE.sub('', ZERO_WIDTH_RE.sub('', text))


def invisible_view(text: str) -> Optional[Tuple[str, array]]:
    """Text without invisible characters and the index map back to `text`
    (map[i] is the index of clean[i]; map[len(clean)] is len(text)). None when
    the text has no invisible character. See invisibleView in rules.js."""
    runs = sorted([m.span() for m in ZERO_WIDTH_RE.finditer(text)]
                  + [m.span() for m in INVISIBLE_ASTRAL_RE.finditer(text)])
    if not runs:
        return None
    mapping = array('q')
    pos = 0
    for start, end in runs:
        mapping.extend(range(pos, start))
        pos = end
    mapping.extend(range(pos, len(text)))
    mapping.append(len(text))
    return _strip_invisible(text), mapping


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
])


def _strict(strict: Optional[bool]) -> bool:
    # The environment can only harden: strict=False does not lift ZN_STRICT=1 (as in Node.js).
    return bool(strict) or os.environ.get('ZN_STRICT') == '1'


def _evaluate_uncached(input_text: str, strict: bool = False) -> Assessment:
    if not isinstance(input_text, str) or not input_text.strip():
        return Assessment(verdict='allow', confidence=1.0, rule='none', reason=None)
    if len(input_text) > MAX_SCAN_CHARS:
        # NUL is neither whitespace nor a word character, so normalization
        # cannot join the end of the head and the start of the tail.
        window = input_text[:SCAN_HEAD_CHARS] + '\u0000' + input_text[-SCAN_TAIL_CHARS:]
        res = _evaluate_uncached(window, strict)
        res.truncated = True
        return res

    normalized, stripped = normalize_input(input_text)
    # The raw input is matched with the same characters as in Node.js (see _CASE_FOLD_GUARD).
    raw = input_text.translate(_CASE_FOLD_GUARD)

    tier_advisory = None

    # Check Base64 payload smuggling
    b64_advisory = None
    for text_candidate in (normalized, stripped):
        b64_match = B64_EXEC_RE.search(text_candidate)
        if b64_match:
            try:
                decoded = base64.b64decode(b64_match.group(1)).decode('utf-8', errors='ignore')
                inner_res = evaluate(decoded, strict=strict)
                if inner_res.advisory:
                    b64_advisory = dict(inner_res.advisory)
                if not inner_res.allowed:
                    return Assessment(
                        verdict='block',
                        confidence=inner_res.confidence,
                        rule='evasion:base64_smuggling',
                        reason=f'Smuggled Base64 execution: {inner_res.reason or inner_res.rule}'
                    )
            except Exception:
                pass

    targets = list(dict.fromkeys([normalized, stripped, raw]))

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
SECRET_PATTERNS: List[Tuple[str, re.Pattern, str]] = [
    # A body may not contain another BEGIN header: linear on repeated headers without END.
    ("secret:private_key", re.compile(r"""-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----"""), "[REDACTED_PRIVATE_KEY]"),
    ("secret:anthropic_key", re.compile(r'(?<![A-Za-z0-9_])(sk-ant-[A-Za-z0-9_-]{30,})(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))'), "[REDACTED_ANTHROPIC_KEY]"),
    # A key without a known prefix ends at the first character that is not a letter or digit.
    ("secret:openai_key", re.compile(r"""(?<![A-Za-z0-9_])(sk-(?:(?:proj|svcacct|admin|[Nn]one|or-v1|lf)-[A-Za-z0-9_-]{28,}(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))|helicone-(?:(?:eu|cp|gov|rl)-){0,4}[a-z0-9]{7}(?:-[a-z0-9]{7}){3}(?![a-z0-9])|(?=(?:eu|cp|gov|rl)-|[a-z0-9]{7}-)(?=[a-z-]{0,46}[0-9])(?:(?:eu|cp|gov|rl)-){0,4}[a-z0-9]{7}(?:-[a-z0-9]{7}){3}(?![a-z0-9])(?!-[a-z0-9])|sp-[A-Za-z0-9]{28,}(?![A-Za-z0-9])|[A-Za-z0-9]{28,}(?![A-Za-z0-9])|(?:(?!sk-)[A-Za-z0-9_-]){1,200}?T3BlbkFJ[A-Za-z0-9_-]{20,}(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))))"""), "[REDACTED_OPENAI_KEY]"),
    ("secret:aws_access_key", re.compile(r'(?<![A-Za-z0-9_])(AKIA[0-9A-Z]{16})(?![A-Za-z0-9_])'), "[REDACTED_AWS_KEY]"),
    ("secret:aws_secret_key", re.compile(r"""((?:[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy]|[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Ww][Ss]_[Kk][Ee][Yy])\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})(['"]?)"""), r'\1[REDACTED_AWS_SECRET]\3'),
    ("secret:github_token", re.compile(r'(?<![A-Za-z0-9_])((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,40}|github_pat_[A-Za-z0-9_]{82})(?![A-Za-z0-9_])'), "[REDACTED_GITHUB_TOKEN]"),
    ("secret:db_url_password", re.compile(r'((?:[Pp][Oo][Ss][Tt][Gg][Rr][Ee][Ss](?:[Qq][Ll])?|[Mm][Yy][Ss][Qq][Ll]|[Mm][Oo][Nn][Gg][Oo][Dd][Bb](?:\+[Ss][Rr][Vv])?|[Rr][Ee][Dd][Ii][Ss]|[Aa][Mm][Qq][Pp]):\/\/[^:\s\/]+:)([^@\s\/]+)(@)'), r'\1[REDACTED_DB_PASSWORD]\3'),
    # The lookahead + backreference pairs act as atomic groups, so a long run of
    # "-eyJ" cannot make the engine retry every split point, and the lookbehind
    # allows a single start per token. Only used when the
    # text contains ".eyJ" (see SECRET_PATTERN_REQUIRES).
    ("secret:jwt_token", re.compile(r'(?<![A-Za-z0-9_-])(eyJ(?=([A-Za-z0-9_-]{10,512}))\2\.eyJ(?=([A-Za-z0-9_=-]{10,8192}))\3\.[A-Za-z0-9_.+/=-]{10,4096})(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))'), "[REDACTED_JWT]"),
    # Credential assignments. A name right after "${" is a shell reference, and
    # after "$" (PHP, PowerShell, Perl) only "=" assigns: "$NAME:" is a reference
    # followed by text. The value (group 2) is checked with _is_non_secret_value.
    ("secret:env_credential", re.compile(r"""(?=[A-Za-z0-9_])(?<![A-Za-z0-9_])(?<!\$\{)(?:(?<!\$)|(?=[A-Za-z0-9_]+\s*=))((?:[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]_[Kk][Ee][Yy]|[Aa][Pp][Ii]_[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh]_[Tt][Oo][Kk][Ee][Nn]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee]_[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]_[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd])["']?\s*[:=]\s*['"]?)([^\s'"]{12,})(['"]?)"""), r'\1[REDACTED_SECRET]\3'),
    # Environment-style names with a prefix: OPENAI_API_KEY=, "DB_PASSWORD": "...",
    # `ENV X_TOKEN value` in a Dockerfile, $X_SECRET = '...' in PHP. Upper case
    # only, so code such as `token = response.json()` is left alone.
    ("secret:prefixed_credential", re.compile(r"""(?=[A-Z0-9])(?<![A-Za-z0-9_])(?<!\$\{)(?:(?<!\$)|(?=[A-Za-z0-9_]+[ \t]*=))((?:ENV[ \t]+(?:[A-Z0-9]+_)+(?:API_KEY|APIKEY|SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIALS|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD)[ \t]+|(?:[A-Z0-9]+_)+(?:API_KEY|APIKEY|SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIALS|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD)["']?[ \t]*[:=][ \t]*)['"]?)([^\s'"]{12,})(['"]?)"""), r'\1[REDACTED_SECRET]\3'),
    # The default of a shell or Compose reference, ${DB_PASSWORD:-<value>}: only
    # redacted when it looks machine-generated (most defaults are for development).
    ("secret:credential_default", re.compile(r"""(\$\{(?:[A-Z0-9]+_)*(?:API_KEY|APIKEY|SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIALS|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD):?[-=])([^\s'"{}$]{12,})(\})"""), r'\1[REDACTED_SECRET]\3'),
]

# Substrings a text must contain before the pattern is run at all.
SECRET_PATTERN_REQUIRES: Dict[str, str] = {
    "secret:jwt_token": ".eyJ",
    "secret:credential_default": "${",
}

# A text without a match for one of these cannot match the credential patterns,
# which are then not run at all.
SECRET_PATTERN_PREFILTERS: Dict[str, re.Pattern] = {
    "secret:env_credential": re.compile(r"""_[Kk][Ee][Yy]|_[Tt][Oo][Kk][Ee][Nn]|_[Pp][Aa][Ss][Ss]"""),
    "secret:prefixed_credential": re.compile(r"""KEY|TOKEN|SECRET|PASS|PWD|CREDENTIALS"""),
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
CREDENTIAL_URL_RE = re.compile(r"""^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\/@:\s]*:([^\/@\s]*)@)?""")
CREDENTIAL_STORE_RE = re.compile(r"""^(?:arn:|vault:|secretref:|@Microsoft\.KeyVault\(|projects\/[^\/]+\/secrets\/)""")
CREDENTIAL_CODE_ROOT_RE = re.compile(r"""^(?:process\.env[.\[]|import\.meta\.env[.\[]|os\.environ|os\.getenv\(|getenv\(|settings\.|config\.|secrets\.|std::env::|env::var|ENV(?:\[|\.fetch\()|\$ENV\{|System\.getenv\(|Deno\.env\.|Bun\.env\.|\[Environment\]::|\([A-Z][a-z]+-[A-Z])""")
CREDENTIAL_PLACEHOLDER_RE = re.compile(r"""^(?:%\([A-Za-z_]*\)s|<[^<>]*>|\{\{[^{}]*\}\}|\$\{[^{}]*\}|#\{[^{}]*\}|\*+|!(?:Ref|Sub|GetAtt|ImportValue|Join|Select|Split|FindInMap|If|Base64|Cidr|GetAZs|Equals|And|Or|Not|Condition|Transform)|([A-Za-z0-9])(?:\1|[-_.:])*)$""")
CREDENTIAL_REFERENCE_NAME_RE = re.compile(r"""^(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9_.-]*|[A-Za-z][a-z]+(?:[A-Z][a-z]+)*[0-9]*)$""")
CREDENTIAL_REFERENCE_RE = re.compile(r"""^(?:\$\$?([A-Za-z_][A-Za-z0-9_]*)|\$env:([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%|@([A-Za-z0-9_.-]+)@|\[([^\[\]]*)\])$""")
CREDENTIAL_PLACEHOLDER_MARK_RE = re.compile(r"""<[^<>]*>|^[<{\[]|^\$\(|^(?:0123456789|1234567890|[Aa][Bb][Cc][Dd][Ee][Ff]|[Qq][Ww][Ee][Rr][Tt][Yy])|([A-Za-z0-9])\1{7,}""")
CREDENTIAL_PLACEHOLDER_MARKS = ('xxxx', '***', '...', '${', '#{', '{{', 'deadbeef')
# re.ASCII keeps case folding to ASCII letters, as in JavaScript.
CREDENTIAL_PLACEHOLDER_WORDS = re.compile(r"""(?<![A-Za-z])(?:password|passwd|passw0rd|secret|changeme|change_me|example|placeholder|your[_-]?|redacted|dummy|sample|foobar|hunter2|todo|insert|replace|mypass|pass(?:word)?123|fake|mock|tests?|testing|demo|stub|fixme|not[_-]?set|unset|set[_-]me|change[_-]this)(?![A-Za-z])""", re.IGNORECASE | re.ASCII)
# The same pattern without IGNORECASE, applied to the value with ASCII letters
# lower-cased: same result, several times faster in Python's re.
_PLACEHOLDER_WORDS_LOWER = re.compile(CREDENTIAL_PLACEHOLDER_WORDS.pattern)
_ASCII_LOWER = str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
CREDENTIAL_CODE_RE = re.compile(r"""^[(!&*@:]*([A-Za-z_$][A-Za-z0-9_$]*(?:(?:\?\.|\.|::|->)[A-Za-z_$][A-Za-z0-9_$]*)*)(?:((?:->[(\[{]|!?[(\[])(?:[A-Za-z0-9_$.:=(\[{!?&|,]|[)\]}](?![A-Za-z0-9_$]))*)|!|[)\]]*)$""")
CREDENTIAL_DOTTED_WORDS_RE = re.compile(r"""^[a-z]+(?:\.[a-z]+){2,}$""")
CREDENTIAL_IDENTIFIER_RE = re.compile(r"""^(?:_*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+_*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z]+)$""")
CREDENTIAL_PATH_RE = re.compile(r"""^(?:(?:~|\.{1,2})?\/|[A-Za-z]:[\\\/]|\\\\)[^+=]*$|^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$""")
CREDENTIAL_FILE_EXT_RE = re.compile(r"""\.[A-Za-z][A-Za-z0-9]{0,4}$""")
CREDENTIAL_FILE_NAME_RE = re.compile(r"""^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:json|ya?ml|pem|p8|p12|pfx|key|keystore|jks|crt|cer|der|txt|ini|toml|conf|cfg|xml|properties|env|gpg|asc|ppk|pub|kdbx)$""")
CREDENTIAL_HOST_NAME_RE = re.compile(r"""^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.(?:com|net|org|io|dev|app|cloud|internal|local|svc|co|ai|sh)$""")
CREDENTIAL_SLUG_RE = re.compile(r"""^[a-z0-9]+(?:[-.][a-z0-9]+)+$""")
CREDENTIAL_SLUG_SHORT_WORD_RE = re.compile(r"""(?:^|[-.])(?:[a-z0-9]{1,3}|[a-z]*[0-9][a-z0-9]*)(?:[-.]|$)""")
CREDENTIAL_OBJECT_NAME_RE = re.compile(r"""_(?:SECRET|CREDENTIALS)(?![A-Za-z0-9_])""")
CREDENTIAL_LETTERS_RE = re.compile(r"""^[A-Za-z]+(?:[-_.][A-Za-z]+)*$""")
CREDENTIAL_DESCRIPTIVE_WORDS = re.compile(r"""(?:^|-)(?:keys?|tokens?|secrets?|pass|passwords?|passwd|pwd|api|apikey|auth|credentials?|access|private|here|value|string|my|your|default|dev|development|local|prod|production|staging|none|null|empty|required|some|generated|random|change|replace|set|use|put|enter|fill|ask|get|see|from|the|not|check|contact|generate|read|find|fake|mock|tests?|dummy|example|sample|placeholder|todo)(?:-|$)|secret|passw|token|apikey|changeme|example|placeholder|dummy""")
CREDENTIAL_HEX_RE = re.compile(r"""^[0-9A-Fa-f]{32,}$""")
WORD_TOKEN_RE = re.compile(r"""[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+""")
_DIGIT_RE = re.compile(r'[0-9]')
_LOWER_RE = re.compile(r'[a-z]')
_UPPER_RE = re.compile(r'[A-Z]')
_SYMBOL_RE = re.compile(r'[^A-Za-z0-9]')
_CHAIN_SPLIT_RE = re.compile(r'\?\.|\.|::|->')
_CHAIN_SEP_RE = re.compile(r'\.|::|->')
_PATH_SPLIT_RE = re.compile(r'[\\\/]')
_PATH_ROOT_RE = re.compile(r'^[~.\/\\]|^[A-Za-z]:')
_URL_PASSWORD_REF_RE = re.compile(r'^[$%<{]')
_HEX_LETTER_RE = re.compile(r'[A-Fa-f]')
_SLUG_SPLIT_RE = re.compile(r'[-.]')
_REF_SPLIT_RE = re.compile(r'[-_.]')
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
_TOKEN_ALPHA_RE = re.compile(r'[A-Za-z]')


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


_PV_PLACEHOLDER_RE = re.compile(
    r'x{3,}|\*{3,}|\.{3,}|-+|_+|<[^>]*>|\$\{?[^}]*\}?|\{\{?[^}]*\}?\}|%\(?[a-z_]*\)?s|:[a-z_]+|\[[^\]]*\]',
    re.IGNORECASE | re.ASCII)
_PV_PLACEHOLDER_WORDS = re.compile(
    r'(?:^|[^a-z])(?:password|passwd|passw0rd|secret|changeme|change_me|example|placeholder|your[_-]?|'
    r'redacted|dummy|sample|foobar|hunter2|xxxx|todo|insert|replace|mypass|pass(?:word)?123)(?:[^a-z]|$)',
    re.IGNORECASE | re.ASCII)
_PV_PLACEHOLDER_SEQ = re.compile(r'0123456789|1234567890|abcdef|qwerty', re.IGNORECASE | re.ASCII)
_PV_POLAR_PREFIX = re.compile(r'polar_(?:oat|pat|(?:at|rt)_[uo]|ci|cs)_')


def _pv_placeholder(s: str) -> bool:
    """patterns.js isPlaceholder."""
    if not s or _PV_PLACEHOLDER_RE.fullmatch(s) or _PV_PLACEHOLDER_WORDS.search(s):
        return True
    return bool(re.fullmatch(r'(.)\1+', s) or _PV_PLACEHOLDER_SEQ.match(s))


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
    # A user that is a shell reference ("https://$TOKEN:x-oauth-basic@host") is a template.
    # A password that is only a reference ($NAME, ${NAME}, %NAME%, <name>, {{name}}) is not a
    # literal secret; one that merely starts with one of those characters still is.
    if user[:1] in ("$", "%", "<", "{"):
        return True
    if re.fullmatch(r'\$\{?\w+\}?|%\w+%|<[^<>\s]+>|\{\{?\s*[\w.]+\s*\}?\}', pw):
        return True
    if re.fullmatch(r'[A-Za-z]{1,8}', pw) or re.fullmatch(r'(?:%[0-9A-Fa-f]{2}){1,2}', pw):
        return True
    return False


def _pv_bearer_not_secret(token: str, prefix: str) -> bool:
    return _pv_placeholder(token)


PROVIDER_SECRET_PATTERNS: List[Tuple[str, re.Pattern, str]] = [
    ("secret:aws_key_id", re.compile(_ALNUM_B + r'(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}' + _ALNUM_A), "[REDACTED_AWS_KEY]"),
    ("secret:gitlab_token", re.compile(_TB + r'gl(?:pat|dt|rt|ptt|cbt|ft|soat)-[A-Za-z0-9_-]{20,}' + _TA), "[REDACTED_GITLAB_TOKEN]"),
    ("secret:slack_token", re.compile(_TB + r'(?:xox[abeprs]-[0-9]{6,}-[A-Za-z0-9-]{8,}|xapp-[0-9]-[A-Z0-9]{6,}-[0-9]{6,}-[a-f0-9]{32,})' + _TA), "[REDACTED_SLACK_TOKEN]"),
    ("secret:slack_webhook", re.compile(r'https://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9/_-]{20,}'), "[REDACTED_SLACK_WEBHOOK]"),
    ("secret:discord_webhook", re.compile(r'https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/[0-9]{15,20}/[A-Za-z0-9_-]{60,}'), "[REDACTED_DISCORD_WEBHOOK]"),
    ("secret:stripe_key", re.compile(_TB + r'(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{20,247}' + _TA), "[REDACTED_STRIPE_KEY]"),
    ("secret:stripe_webhook_secret", re.compile(_TB + r'whsec_[A-Za-z0-9+/]{32,}' + _TA), "[REDACTED_STRIPE_WEBHOOK_SECRET]"),
    ("secret:google_api_key", re.compile(_TB + r'AIza[0-9A-Za-z_-]{35}' + _TA), "[REDACTED_GOOGLE_API_KEY]"),
    ("secret:google_oauth_secret", re.compile(_TB + r'GOCSPX-[A-Za-z0-9_-]{28}' + _TA), "[REDACTED_GOOGLE_OAUTH_SECRET]"),
    ("secret:hf_token", re.compile(_TB + r'hf_[A-Za-z0-9]{34,40}' + _TA), "[REDACTED_HF_TOKEN]"),
    ("secret:npm_token", re.compile(_TB + r'npm_[A-Za-z0-9]{36}' + _TA), "[REDACTED_NPM_TOKEN]"),
    ("secret:pypi_token", re.compile(_TB + r'pypi-AgE[A-Za-z0-9_-]{50,}' + _TA), "[REDACTED_PYPI_TOKEN]"),
    ("secret:sendgrid_key", re.compile(_TB + r'SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}' + _TA), "[REDACTED_SENDGRID_KEY]"),
    ("secret:twilio_key", re.compile(_ALNUM_B + r'SK(?:[0-9a-f]{32}|[0-9A-F]{32})' + _ALNUM_A), "[REDACTED_TWILIO_KEY]"),
    ("secret:mailgun_key", re.compile(_TB + r'key-[0-9a-f]{32}' + _TA), "[REDACTED_MAILGUN_KEY]"),
    ("secret:shopify_token", re.compile(_TB + r'shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}' + _TA), "[REDACTED_SHOPIFY_TOKEN]"),
    ("secret:digitalocean_token", re.compile(_TB + r'do[opr]_v1_[a-f0-9]{64}' + _TA), "[REDACTED_DIGITALOCEAN_TOKEN]"),
    ("secret:linear_key", re.compile(_TB + r'lin_api_[A-Za-z0-9]{40}' + _TA), "[REDACTED_LINEAR_KEY]"),
    ("secret:telegram_bot_token", re.compile(_ALNUM_B + r'[0-9]{8,10}:AA[A-Za-z0-9_-]{33}' + _TA), "[REDACTED_TELEGRAM_BOT_TOKEN]"),
    ("secret:azure_storage_key", re.compile(r'(AccountKey=)([A-Za-z0-9+/]{86}==)'), r'\1[REDACTED_AZURE_STORAGE_KEY]'),
    ("secret:databricks_token", re.compile(_TB + r'dapi[a-f0-9]{32}(?:-[0-9])?' + _TA), "[REDACTED_DATABRICKS_TOKEN]"),
    ("secret:vault_token", re.compile(_TB + r'hv[sb]\.[A-Za-z0-9_-]{24,}' + _TA), "[REDACTED_VAULT_TOKEN]"),
    ("secret:doppler_token", re.compile(_TB + r'dp\.(?:st|pt|sa|scim|audit|ct)\.[A-Za-z0-9_.-]{40,}' + _TA), "[REDACTED_DOPPLER_TOKEN]"),
    ("secret:newrelic_key", re.compile(_TB + r'NR(?:AK|II)-[A-Z0-9]{27}' + _TA), "[REDACTED_NEWRELIC_KEY]"),
    ("secret:groq_key", re.compile(_TB + r'gsk_[A-Za-z0-9]{52}' + _TA), "[REDACTED_GROQ_KEY]"),
    ("secret:xai_key", re.compile(_TB + r'xai-[A-Za-z0-9]{80}' + _TA), "[REDACTED_XAI_KEY]"),
    ("secret:dockerhub_pat", re.compile(_TB + r'dckr_(?:pat|oat)_[A-Za-z0-9_-]{20,}' + _TA), "[REDACTED_DOCKERHUB_PAT]"),
    ("secret:tavily_key", re.compile(_TB + r'tvly-[A-Za-z0-9_-]{20,}' + _TA), "[REDACTED_TAVILY_KEY]"),
    ("secret:firecrawl_key", re.compile(_TB + r'fc-[A-Za-z0-9]{20,}' + _TA), "[REDACTED_FIRECRAWL_KEY]"),
    ("secret:polar_token", re.compile(_TB + r'polar_(?:oat|pat|(?:at|rt)_[uo]|ci|cs)_[A-Za-z0-9_-]{20,}' + _TA), "[REDACTED_POLAR_TOKEN]"),
    ("secret:replicate_token", re.compile(_TB + r'r8_[A-Za-z0-9]{37}' + _TA), "[REDACTED_REPLICATE_TOKEN]"),
    ("secret:supabase_pat", re.compile(_TB + r'sbp_[A-Za-z0-9_-]{30,}' + _TA), "[REDACTED_SUPABASE_PAT]"),
    ("secret:azure_ad_client_secret", re.compile(r'(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.]{3}[0-9]Q~[A-Za-z0-9_~.-]{30,33}[A-Za-z0-9_~-](?![A-Za-z0-9_~-])(?!\.[A-Za-z0-9_~-])'), "[REDACTED_AZURE_AD_CLIENT_SECRET]"),
    # Password segment of scheme://user:password@host (any scheme, as DB_PASSWORD in patterns.js).
    # The scheme does not start inside a longer word, Unicode letters included (a long s is not an s).
    ("secret:url_password", re.compile(r"((?<!\w)[a-zA-Z][a-zA-Z0-9+.-]{1,24}://[^\s:@/?#'\"`<>]{0,128}:)([^\s@/?#'\"`<>]{1,256})(@(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]))"), r'\1[REDACTED_URL_PASSWORD]\3'),
    # Authorization header with a bearer token (not in patterns.js). zn's own
    # __ZN_ markers are not secrets.
    ("secret:bearer_token", re.compile(r'(Authorization[ \t]*:[ \t]*Bearer[ \t]+)([A-Za-z0-9._~+/=-]{20,})', re.IGNORECASE | re.ASCII), r'\1[REDACTED_BEARER_TOKEN]'),
]

# Whole-match checks (patterns.js `check`), keyed by rule id.
PROVIDER_MATCH_CHECKS: Dict[str, Any] = {
    "secret:aws_key_id": lambda v: re.fullmatch(r'(.)\1+', v[4:]) is None and not v.endswith('EXAMPLE'),
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
    "secret:azure_ad_client_secret": ("Q~",),
    "secret:url_password": ("://",),
}


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


def _span_in(mapping: Optional[array], start: int, end: int) -> Tuple[int, int]:
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


def _rule_candidates(rule_id: str, pattern: re.Pattern, replacement: str, text: str,
                     view: Optional[Tuple[str, array]], budget: List[int], value_filter,
                     out: List[Tuple[int, int, str, str]], match_check=None) -> None:
    """Candidate redactions of one rule as (start, end, rule_id, replacement) in
    original coordinates. The rule runs on the original text and on the text
    without invisible characters (see ruleCandidates in rules.js). match_check,
    when given, receives the whole match and returns False to skip it."""
    passes: List[Tuple[str, Optional[array]]] = [(text, None)]
    if view is not None:
        passes.append(view)
    for hay, mapping in passes:
        required = SECRET_PATTERN_REQUIRES.get(rule_id)
        if required and required not in hay:
            continue
        hints = PROVIDER_HINTS.get(rule_id)
        if hints and not any(h in hay for h in hints):
            continue
        prefilter = SECRET_PATTERN_PREFILTERS.get(rule_id)
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
                vs, ve = groups[2]
                value = _strip_invisible(text[vs:ve])
                prefix = ''
                if groups[1] is not None:
                    prefix = _strip_invisible(text[groups[1][0]:groups[1][1]])
                n = _utf16_len(value)
                if n <= MAX_FILTERED_VALUE and n <= budget[0]:
                    budget[0] -= n
                    if value_filter(value, prefix):
                        continue
            start, end = _span_in(mapping, m.start(), m.end())
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
    if not isinstance(text, str) or not text:
        return text, []

    redacted = text
    detections: List[Dict[str, Any]] = []
    budget = [MAX_FILTERED_CHARS]
    view = None
    dirty = True

    for rule_id, pattern, replacement in SECRET_PATTERNS + PROVIDER_SECRET_PATTERNS:
        if dirty:
            view = invisible_view(redacted)
            dirty = False
        cands: List[Tuple[int, int, str, str]] = []
        value_filter = SECRET_VALUE_FILTERS.get(rule_id) or PROVIDER_VALUE_FILTERS.get(rule_id)
        _rule_candidates(rule_id, pattern, replacement, redacted, view, budget,
                         value_filter, cands, PROVIDER_MATCH_CHECKS.get(rule_id))
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
_TOKEN_RUN_RE = re.compile(r'[A-Za-z0-9_\-+/=]{24,}')
_UUID_FULL_RE = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
_UUID_RE = re.compile(r'(?<![0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z])')
_RUN_SEP_RE = re.compile(r'[-_/]+')
# One part of an identifier: a word (lower, Capitalized or camelCase) with an
# optional short number, or a short number.
_WORDY_PART_RE = re.compile(r'(?:[A-Z]+\d{0,4}|[A-Za-z][a-z]*(?:[A-Z][a-z]+)*[A-Z]?\d{0,4}|\d{1,4})?')


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


def scan_windows(text: str, strict: Optional[bool] = None) -> Assessment:
    strict = _strict(strict)
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


def sanitize_tool_result(
    tool_or_result: Any,
    content: Optional[Any] = None,
    mask_secrets: bool = True,
    block_truncated: bool = False,
    strict: Optional[bool] = None,
) -> Any:
    """
    Sanitizes tool output to prevent prompt injection and credential leakage.
    Can be called as:
      1) sanitize_tool_result(data) -> returns (clean_data, detections)
      2) sanitize_tool_result(tool_name, content, mask_secrets=True) -> returns dict with
         {tool_name, safe_to_ingest, truncated, assessment, secrets_redacted, sanitized_content}
    Tool output longer than MAX_TOOL_RESULT_SCAN_CHARS is not fully analysed:
    `truncated` is then True, and the output is blocked when block_truncated is
    set or the ZN_BLOCK_TRUNCATED environment variable is "1".
    """
    if content is not None:
        tool_name = str(tool_or_result)
        text_content = content if isinstance(content, str) else str(content)
        assessment = scan_windows(text_content, strict=strict)
        truncated = assessment.truncated
        if truncated and assessment.allowed and (block_truncated or os.environ.get('ZN_BLOCK_TRUNCATED') == '1'):
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

    def _sanitize(val: Any) -> Any:
        if isinstance(val, str):
            clean_str, det = redact_secrets(val)
            if det:
                detections.extend(det)
            return clean_str
        elif isinstance(val, dict):
            return {k: _sanitize(v) for k, v in val.items()}
        elif isinstance(val, list):
            return [_sanitize(v) for v in val]
        elif isinstance(val, tuple):
            return tuple(_sanitize(v) for v in val)
        return val

    sanitized = _sanitize(tool_or_result)
    return sanitized, detections



_EVAL_CACHE_MAX = 2048
# Only inputs up to 8 KB are cached, so the cache itself stays small.
EVAL_CACHE_MAX_INPUT = 8 * 1024
_eval_cache = {}
_eval_cache_ver = RULES_VERSION


def evaluate(input_text: str, strict: Optional[bool] = None) -> Assessment:
    """Cached entry point: LRU(2048) keyed on raw input and strict mode, version-guarded.

    strict=True (or ZN_STRICT=1) also blocks the heuristic rules that are
    advisories by default (ADVISORY_BY_DEFAULT)."""
    global _eval_cache_ver
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
        return Assessment(*hit[:7], advisory=dict(hit[7]) if hit[7] else None)
    res = _evaluate_uncached(input_text, strict)
    _eval_cache[key] = (res.verdict, res.confidence, res.rule,
                               res.reason, res.engine, res.rules_version, res.truncated,
                               dict(res.advisory) if res.advisory else None)
    if len(_eval_cache) > _EVAL_CACHE_MAX:
        _eval_cache.pop(next(iter(_eval_cache)))
    return res
