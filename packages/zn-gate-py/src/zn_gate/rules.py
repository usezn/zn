"""
zn deterministic rules engine - Python stdlib implementation.
RULES_VERSION: 2026-10-12.5
Zero external dependencies. Pure Python stdlib.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple

RULES_VERSION = "2026-10-12.5"

# Cyrillic homoglyphs mapping to Latin
HOMOGLYPH_MAP = {
    '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
    '\u0456': 'i', '\u0455': 's', '\u0443': 'y', '\u0445': 'x',
    '\u0410': 'A', '\u0415': 'E', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C',
}

# Rule patterns mirror packages/zn-gate/lib/rules.js: the source strings are
# identical (tests/test_rules_parity.py compares them) and the JavaScript "i"
# flag maps to re.IGNORECASE. Every pattern runs in linear time: no unbounded
# lazy wildcards, and repeated character classes are bounded.
ZERO_WIDTH_RE = re.compile(r'[\u200B-\u200D\uFEFF\u00AD]')
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
_OVERRIDE_NOUN = r'(?:instructions?|prompts?|rules|guidelines?|directives?|guidance|restrictions?|guardrails?|context|constraints?|commands?|policies|programming|orders|limitations?|directions|requests?|tasks?)\b'
_OVERRIDE_QUANTIFIER = r'(?:all|any|every|each|your|my|these|those)(?:\s{1,32}of)?\s{1,32}'
_OVERRIDE_DETERMINER = r'(?:(?:the|your|my|these|those|our|its|their)\s{1,32})?'
_OVERRIDE_QUALIFIER = r'(?:previous|prior|above|earlier|preceding|foregoing|original|initial|existing|system|safety|security|former|developer)\s{1,32}'
# "ignore the above" / "ignore previous" without a noun counts only at the end
# of a clause, before "and" or before a word for text ("ignore the above
# text"), so "ignore the previous build output" stays allowed.
_OVERRIDE_END = r'(?=[ \t]*(?:[.,;:!)\r\n]|$)|\s{1,32}and\b|\s{1,32}(?:text|content|message|messages|input|lines?|one|ones)\b)'


def _override_rule_source(verb: str) -> str:
    return '|'.join([
        verb + r'\s{1,32}(?:' + _OVERRIDE_QUANTIFIER + r')?' + _OVERRIDE_DETERMINER + r'(?:' + _OVERRIDE_QUALIFIER + r'){1,2}' + _OVERRIDE_NOUN,
        verb + r'\s{1,32}' + _OVERRIDE_QUANTIFIER + _OVERRIDE_DETERMINER + _OVERRIDE_NOUN,
        verb + r'\s{1,32}(?:the\s{1,32})?(?:instructions|guardrails|directives)\b',
        verb + r'\s{1,32}(?:' + _OVERRIDE_QUANTIFIER + r')?(?:the\s{1,32})?(?:previous|prior|above|earlier|preceding|foregoing)' + _OVERRIDE_END,
        verb + r"\s{1,32}(?:everything|anything|all)\s{1,32}(?:above|before|previously|prior|earlier|you(?:'ve|\s{1,32}have|\s{1,32}were|\s{1,32}was)?\s{1,32}(?:been\s{1,32})?(?:told|said|given|received))\b",
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
    ('pi:forget', re.compile(r'forget\s+(about\s+)?(everything|all|your)', re.IGNORECASE), 'Forget-context attack'),
    ('pi:identity_override', re.compile(r'you\s+are\s+now', re.IGNORECASE), 'Identity override'),
    ('pi:new_instructions', re.compile(r'new\s+instructions?:', re.IGNORECASE), 'Instruction replacement'),
    ('pi:system_tag', re.compile(r"""(?:^|[\r\n"'`\[<])[ \t]*system\s*:|<[\s/]*system\b[^<>]*>""", re.IGNORECASE), 'Fake system tag'),
    ('pi:system_bracket', re.compile(r'\[system\]', re.IGNORECASE), 'Bracketed system tag'),
    ('pi:act_as', re.compile(r'act\s+as\s+(if|a)', re.IGNORECASE), 'Role hijack (act as)'),
    ('pi:pretend', re.compile(r'pretend\s+(you|to\s+be)', re.IGNORECASE), 'Role hijack (pretend)'),
    ('pi:roleplay', re.compile(r'roleplay\s+as', re.IGNORECASE), 'Role hijack (roleplay)'),
    ('pi:jailbreak', re.compile(r'\bjailbreak\b', re.IGNORECASE), 'Explicit jailbreak term'),
    ('pi:bypass', re.compile(r'bypass\s+(your|the|all)', re.IGNORECASE), 'Guardrail bypass attempt'),
    ('pi:override', re.compile(r'\boverride\s+(?:all\s+|your\s+|the\s+)?(?:system|policy|safety|rules|instructions|guidelines|restrictions)\b|\bsystem\s+override\s*:', re.IGNORECASE), 'Policy override attempt'),
    ('pi:template_boundary', re.compile(r'\[INST\]|\[\/INST\]|<<<SYS>>>|<\/<<SYS>>>|<\|im_start\|>|<\|im_end\|>', re.IGNORECASE), 'Chat template boundary injection'),
    ('pi:multi_es', re.compile(r'ignora\s+(todas\s+las\s+)?(instrucciones|anteriores|previas)|olvida\s+(todo|las\s+instrucciones)|act[uú]a\s+como|ahora\s+eres', re.IGNORECASE), 'Multilingual prompt injection (Spanish)'),
    ('pi:multi_pt', re.compile(r'ignor(?:e|a|em|ar)\s+(?:(?:todas|todos|qualquer|quaisquer|cualquier)\s+)?(?:(?:as|os|las|los|suas|seus|sus|tus|estas|estes|essas|esses)\s+)?(?:instru[cç][oõ]es|instrucciones|regras|reglas|diretrizes|directrices|orienta[cç][oõ]es|ordens|[oó]rdenes|comandos|restri[cç][oõ]es|restricciones|mensagens|anteriores|pr[eé]vias)|ignore\s+(?:tudo|qualquer|quaisquer)\b|ignora\s+(?:todo|tudo|cualquier)\b', re.IGNORECASE), 'Multilingual prompt injection (Portuguese)'),
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
OPEN_TAG_RE = re.compile(r'<[a-z0-9]+\b([^<>]*)(>?)', re.IGNORECASE)
HIDDEN_ATTR_RE = re.compile(r'\b(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0(?:px)?|color\s*:\s*transparent|text-indent\s*:\s*-[0-9]{3,}px|hidden\b)', re.IGNORECASE)
HIDDEN_PAYLOAD_RE = re.compile(r'ignore|system|instruction|prompt|bypass|override|exfil|leak', re.IGNORECASE)


def _test_hidden_tag(text: str) -> bool:
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

EXFIL_VERBS = re.compile(r'\b(give|reveal|send|show|print|expose|leak|paste|dump|read|open|cat|fetch|extract|steal)\b', re.IGNORECASE)
CRED_OBJECTS = re.compile(r"""\b(passwords?|api[_ -]?keys?|secrets?|credentials?|tokens?|ssh[ _-]?keys?|private[ _-]?keys?|aws_secret[a-z0-9_]*|aws_access[a-z0-9_]*)\b|(?:^|\s|['"`])\.env(?:\.[a-z0-9]+)?\b""", re.IGNORECASE)

SENSITIVE_PATH_RULES: List[Tuple[str, re.Pattern, str]] = [
    (
        'path:sensitive_file',
        re.compile(r"""(?:^|[\s"'`(\[])(?:~|\/home\/[^\s/]+|\/root)?\/?\.(?:ssh\/(?:id_rsa|id_ed25519|authorized_keys)|aws\/credentials|env(?:\.[a-z0-9]+)?)\b|\/etc\/(?:shadow|passwd)\b""", re.IGNORECASE),
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


def normalize_input(text: str) -> Tuple[str, str]:
    if not isinstance(text, str):
        return '', ''
    # 1. Strip zero-width evasion characters
    stripped = ZERO_WIDTH_RE.sub('', text)
    # 1b. Strip ANSI escape sequences
    stripped = ANSI_ESCAPE_RE.sub('', stripped)
    # 2. Strip inline C-style comments (e.g. sys/*safe*/tem -> system)
    stripped = _strip_c_comments(stripped)
    # 3. Rejoin words and tokens split across newlines (sys\ntem -> system).
    #    Linear: only the character on each side of a newline run is inspected.
    if '\n' in stripped or '\r' in stripped:
        stripped = WHITESPACE_RUN_RE.sub(_join_line_break, stripped)
    # 4. Normalize homoglyphs (Cyrillic to Latin for English hijack detection)
    normalized = "".join(HOMOGLYPH_MAP.get(c, c) for c in stripped)
    return normalized, stripped


def _evaluate_uncached(input_text: str) -> Assessment:
    if not isinstance(input_text, str) or not input_text.strip():
        return Assessment(verdict='allow', confidence=1.0, rule='none', reason=None)
    if len(input_text) > MAX_SCAN_CHARS:
        # NUL is neither whitespace nor a word character, so normalization
        # cannot join the end of the head and the start of the tail.
        window = input_text[:SCAN_HEAD_CHARS] + '\u0000' + input_text[-SCAN_TAIL_CHARS:]
        res = _evaluate_uncached(window)
        res.truncated = True
        return res

    normalized, stripped = normalize_input(input_text)

    # Check Base64 payload smuggling
    for text_candidate in (normalized, stripped):
        b64_match = B64_EXEC_RE.search(text_candidate)
        if b64_match:
            try:
                decoded = base64.b64decode(b64_match.group(1)).decode('utf-8', errors='ignore')
                inner_res = evaluate(decoded)
                if not inner_res.allowed:
                    return Assessment(
                        verdict='block',
                        confidence=inner_res.confidence,
                        rule='evasion:base64_smuggling',
                        reason=f'Smuggled Base64 execution: {inner_res.reason or inner_res.rule}'
                    )
            except Exception:
                pass

    targets = list(dict.fromkeys([normalized, stripped, input_text]))

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
                return Assessment(verdict='block', confidence=0.95, rule=rule_id, reason=desc)

        # 5. Exfiltration Compound (verb + credentials)
        if EXFIL_VERBS.search(text) and CRED_OBJECTS.search(text):
            return Assessment(
                verdict='block',
                confidence=0.90,
                rule='exfil:credentials',
                reason='Imperative verb requesting credentials/secrets'
            )

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
    ("secret:env_credential", re.compile(r"""(?<![A-Za-z0-9_])((?:[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]_[Kk][Ee][Yy]|[Aa][Pp][Ii]_[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh]_[Tt][Oo][Kk][Ee][Nn]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee]_[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]_[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd])\s*[:=]\s*['"]?)([^\s'"]{12,})(['"]?)"""), r'\1[REDACTED_SECRET]\3'),
]

# Substrings a text must contain before the pattern is run at all.
SECRET_PATTERN_REQUIRES: Dict[str, str] = {
    "secret:jwt_token": ".eyJ",
}

def redact_secrets(text: str) -> Tuple[str, List[Dict[str, Any]]]:
    """
    Scans a text for sensitive credentials (API keys, private keys, passwords)
    and redacts them in place. Returns (redacted_text, detected_secrets_list).
    """
    if not isinstance(text, str) or not text:
        return text, []

    redacted = text
    detections: List[Dict[str, Any]] = []

    for rule_id, pattern, replacement in SECRET_PATTERNS:
        required = SECRET_PATTERN_REQUIRES.get(rule_id)
        if required and required not in redacted:
            continue
        matches = list(pattern.finditer(redacted))
        if matches:
            for m in matches:
                detections.append({
                    "rule": rule_id,
                    "start": m.start(),
                    "end": m.end(),
                })
            redacted = pattern.sub(replacement, redacted)

    return redacted, detections

# Tool output can be large (file reads, search results). Instead of the
# head + tail view used by evaluate(), it is scanned in windows of
# MAX_SCAN_CHARS that overlap by SCAN_WINDOW_OVERLAP, so a payload in the
# middle is not skipped. Past MAX_TOOL_RESULT_SCAN_CHARS only the last window
# is added and the result is marked truncated=True. A match that spans more
# than SCAN_WINDOW_OVERLAP characters across a window boundary can be missed.
SCAN_WINDOW_OVERLAP = 4 * 1024
MAX_TOOL_RESULT_SCAN_CHARS = 4 * 1024 * 1024


def scan_windows(text: str) -> Assessment:
    if not isinstance(text, str) or len(text) <= MAX_SCAN_CHARS:
        return evaluate(text)
    step = MAX_SCAN_CHARS - SCAN_WINDOW_OVERLAP
    limit = min(len(text), MAX_TOOL_RESULT_SCAN_CHARS)
    start = 0
    while True:
        end = min(start + MAX_SCAN_CHARS, limit)
        res = _evaluate_uncached(text[start:end])
        if not res.allowed or end >= limit:
            break
        start += step
    if res.allowed and len(text) > limit:
        res = _evaluate_uncached(text[-MAX_SCAN_CHARS:])
    res.truncated = len(text) > limit
    return res


def sanitize_tool_result(
    tool_or_result: Any,
    content: Optional[Any] = None,
    mask_secrets: bool = True,
    block_truncated: bool = False,
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
        assessment = scan_windows(text_content)
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


def evaluate(input_text: str) -> Assessment:
    """Cached entry point: LRU(2048) keyed on raw input, version-guarded."""
    global _eval_cache_ver
    if not isinstance(input_text, str) or len(input_text) > EVAL_CACHE_MAX_INPUT:
        return _evaluate_uncached(input_text)
    if RULES_VERSION != _eval_cache_ver:
        _eval_cache.clear()
        _eval_cache_ver = RULES_VERSION
    hit = _eval_cache.get(input_text)
    if hit is not None:
        _eval_cache[input_text] = _eval_cache.pop(input_text)
        return Assessment(*hit)
    res = _evaluate_uncached(input_text)
    _eval_cache[input_text] = (res.verdict, res.confidence, res.rule,
                               res.reason, res.engine, res.rules_version, res.truncated)
    if len(_eval_cache) > _EVAL_CACHE_MAX:
        _eval_cache.pop(next(iter(_eval_cache)))
    return res
