"""Plaintext credentials in MCP server configuration files.

The same rules as packages/zn-gate/lib/mcp-secrets.js; the shared samples in
packages/zn-gate/test/fixtures/mcp_config_secret_samples.json keep the two in
step.

The check works on lines, so JSON, JSON with comments and TOML are read the
same way and a file with a syntax error is still checked. It looks at the three
places an MCP server gets a credential: a value under a name that ends in a
secret word (``"BRAVE_API_KEY": "..."``, ``Authorization = "Bearer ..."``), a
credential flag in the arguments (``"--api-key=..."``, or the flag and its value
as two items, maybe on two lines), and a key in a URL
(``https://host/mcp?api_key=...``). A reference (``${NAME}``, ``$NAME``,
``%NAME%``, ``__ZN_NAME__``), a placeholder, a path and a value that reads as
ordinary text are not credentials. The value is never part of a result: only
its kind, the name that holds it and the line.
"""

from __future__ import annotations

import re
from typing import Callable, Dict, List, Optional, Set, Tuple

from .rules import _is_non_secret_value

RULE_ID = "secret:mcp_config"

# Files that hold MCP servers: by name (any folder) or by folder and name.
_MCP_FILE_NAMES = {
    ".mcp.json", "mcp.json", "mcp_config.json", "mcp_settings.json", "cline_mcp_settings.json",
    "claude_desktop_config.json", ".claude.json", "opencode.json", "opencode.jsonc",
}
_MCP_FILE_IN_DIR = [(".codex", "config.toml"), (".gemini", "settings.json")]


def is_mcp_config_path(file: str) -> bool:
    parts = re.split(r"[\\/]", str(file))
    base = (parts[-1] if parts else "").lower()
    if base in _MCP_FILE_NAMES:
        return True
    directory = (parts[-2] if len(parts) > 1 else "").lower()
    return any(d == directory and f == base for d, f in _MCP_FILE_IN_DIR)


def normalize_name(name: str) -> str:
    """Lower-cased, camelCase split, every other run of characters becomes "_":
    apiKey -> api_key, X-Api-Key -> x_api_key."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(name)).lower()
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


_SECRET_NAME = re.compile(
    r"(?:^|_)(?:token|secret|pwd|passphrase|api_?key|access_?key|private_?key|secret_?key|auth_?key|auth|credentials?|bearer|pat)$|passw(?:or)?d$")
_KEY_NAME = re.compile(r"_key$")
_NOT_A_CREDENTIAL_KEY = re.compile(
    r"(?:^|_)(?:public|pub|primary|foreign|sort|cache|partition|hash|shard|route|lookup|translation|object|storage|ssh)_key$")
_HEADER_NAMES = {"authorization", "proxy_authorization", "x_api_key", "x_auth_token", "x_access_token", "cookie"}
_GENERIC_WORDS = {"x", "access", "api", "auth", "authorization", "bearer", "client", "cookie", "credential",
                  "credentials", "key", "pat", "password", "private", "proxy", "secret", "session", "token", "user"}
_NOT_VALUES = re.compile(r"(?:true|false|null|none|oauth2?|basic|bearer|required|optional|env|file|keychain|disabled|enabled)", re.IGNORECASE)
_REFERENCE = re.compile(r"\$\{|\$\(|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%|\{\{|\{(?:env|file):|__ZN_[A-Za-z0-9_]+__|^<|\[REDACTED")
_SCHEME = re.compile(r"^(?:bearer|basic|token)[ \t]+", re.IGNORECASE)
_MIN_VALUE = 6


def is_secret_name(norm: str) -> bool:
    if not norm:
        return False
    if norm in _HEADER_NAMES or _SECRET_NAME.search(norm):
        return True
    return bool(_KEY_NAME.search(norm)) and norm != "key" and not _NOT_A_CREDENTIAL_KEY.search(norm)


def _holds_credential(value: str, with_scheme: bool) -> bool:
    v = str(value).strip()
    if with_scheme:
        v = _SCHEME.sub("", v, count=1)
    if len(v) < _MIN_VALUE or _REFERENCE.search(v) or _NOT_VALUES.fullmatch(v):
        return False
    return not _is_non_secret_value(v)


_IDENT = re.compile(r"[A-Za-z0-9_.-]")
_IDENT_START = re.compile(r"[A-Za-z0-9_]")


class _Token:
    __slots__ = ("is_str", "text", "start", "end", "sep", "value_at")

    def __init__(self, is_str: bool, text: str, start: int, end: int) -> None:
        self.is_str = is_str
        self.text = text
        self.start = start
        self.end = end
        self.sep = False
        self.value_at = -1


def _tokenize(line: str) -> List[_Token]:
    out: List[_Token] = []
    n = len(line)
    i = 0
    while i < n:
        c = line[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < n and line[j] != c:
                j += 2 if (c == '"' and line[j] == "\\") else 1
            if j >= n:
                break  # unterminated: nothing more on this line is a string
            tok = _Token(True, line[i + 1:j], i, j + 1)
        elif _IDENT_START.match(c) and (i == 0 or not _IDENT.match(line[i - 1])):
            j = i
            while j < n and j - i < 80 and _IDENT.match(line[j]):
                j += 1
            tok = _Token(False, line[i:j], i, j)
            if j < n and _IDENT.match(line[j]):  # too long to be a key
                i = j
                continue
        else:
            i += 1
            continue
        k = tok.end
        while k < n and line[k] in " \t":
            k += 1
        sep_char = ""
        if k < n and (line[k] == ":" or (line[k] == "=" and line[k + 1:k + 2] != "=")):
            sep_char = line[k]
        tok.sep = sep_char != ""
        if tok.sep:
            k += 1
            while k < n and line[k] in " \t":
                k += 1
            tok.value_at = k
        # A bare word is a key only when "=" follows it (TOML).
        if not tok.is_str and sep_char != "=":
            i = tok.end
            continue
        out.append(tok)
        i = tok.end
    return out


_FLAG = re.compile(r"--?[A-Za-z][A-Za-z0-9_-]{0,60}")
_FLAG_EQ = re.compile(r"(--?[A-Za-z][A-Za-z0-9_-]{0,60})=(.*)", re.DOTALL)
_HEADER_ARG = re.compile(
    r"(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token|cookie)[ \t]*:[ \t]*(.*)",
    re.IGNORECASE | re.DOTALL)
_URL_START = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,15}://")
_QUERY_PARAM = re.compile(r"[?&;#]([A-Za-z0-9_.-]{1,60})=([^&#\s]*)")
# "Bearer abc": one token after the scheme. A sentence that starts with the word is not a credential.
_SCHEME_VALUE = re.compile(r"(?:bearer|basic)[ \t]+\S+", re.IGNORECASE)
# Names that hold a credential Claude Code itself uses to log in: not moved to the vault.
_OWN_LOGIN_NAMES = {"primary_api_key"}
_CLAUDE_JSON = re.compile(r"(^|[\\/])\.claude\.json$")
# add(kind, name, start, end): offsets of the value in the line
_AddFn = Callable[[str, str, int, int], None]


def _url_params(text: str) -> List[Tuple[str, int, int]]:
    """Credential values in the query of a URL: (norm, offset, length)."""
    if not _URL_START.match(text) or not any(c in text for c in "?#;"):
        return []
    out = []
    for m in _QUERY_PARAM.finditer(text):
        norm = normalize_name(m.group(1))
        if (is_secret_name(norm) or norm in ("key", "sig", "signature")) and _holds_credential(m.group(2), False):
            out.append((norm, m.end() - len(m.group(2)), len(m.group(2))))
    return out


def suggested_name(norm: str) -> str:
    """The environment variable name suggested for a value: the name that holds
    it, with a prefix when that name only says "a token" and not what it is for."""
    up = re.sub(r"[^A-Z0-9_]", "_", (norm or "secret").upper())[:56].rstrip("_")
    generic = all((not w) or w in _GENERIC_WORDS for w in norm.split("_"))
    if generic or not re.match(r"[A-Z]", up):
        up = "MCP_" + up
    return up


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(name))[:80]


def find_mcp_config_secret_spans(text: str, file: str = "") -> List[Dict[str, object]]:
    """Credentials in the text of an MCP configuration file, with where each value
    sits: {"line", "kind", "name", "start", "end"} (offsets in ``text``, lines counted
    on newline characters only). The offsets are for masking the value
    (``mask_mcp_values``); they are never part of a report. ``kind`` is "environment
    variable", "header", "setting", "argument" or "URL". ``file`` is the file name: in
    ~/.claude.json the key Claude Code logs in with is left alone."""
    found: List[Dict[str, object]] = []
    seen: Set[Tuple[int, str, str]] = set()
    own_login = bool(_CLAUDE_JSON.search(str(file)))
    cur = {"ln": 0, "start": 0}

    def add(kind: str, name: str, s: int, e: int) -> None:
        key = (cur["ln"], kind, name)
        if key in seen:
            return
        seen.add(key)
        found.append({"line": cur["ln"], "kind": kind, "name": _safe_name(name),
                      "start": cur["start"] + s, "end": cur["start"] + e})

    pending: List[Optional[str]] = [None]  # a credential flag whose value is the next string

    def set_pending(flag: str) -> None:
        pending[0] = flag

    lines = str(text).split("\n")
    line_start = 0
    for idx, raw in enumerate(lines):
        cur["ln"] = idx + 1
        cur["start"] = line_start
        line_start += len(raw) + 1
        line = raw[:-1] if raw.endswith("\r") else raw
        if not line.strip():
            continue
        toks = _tokenize(line)
        had_pending = pending[0] is not None
        used_pending = False
        t = 0
        while t < len(toks):
            tok = toks[t]
            nxt = toks[t + 1] if t + 1 < len(toks) else None
            t += 1
            if tok.sep:
                # A key. Its value is the string that follows it.
                if nxt is not None and nxt.is_str and nxt.start == tok.value_at:
                    _pair(tok.text, nxt.text, nxt.start + 1, add, own_login)
                    t += 1
                continue
            if not tok.is_str:
                continue
            s = tok.text
            if pending[0] is not None:
                flag = pending[0]
                pending[0] = None
                used_pending = True
                if not s.startswith("-") and _holds_credential(s, True):
                    add("argument", flag, tok.start + 1, tok.end - 1)
                    continue
            _argument(s, tok.start + 1, add, set_pending)
        # A flag waits for its value only across comment and blank lines.
        if had_pending and not used_pending and pending[0] is not None and not re.match(r"^\s*(?:#|//|/\*|\*)", line):
            pending[0] = None
    return found


def find_mcp_config_secrets(text: str, file: str = "") -> List[Dict[str, object]]:
    """The same results without the offsets: {"line", "kind", "name"}."""
    return [{"line": f["line"], "kind": f["kind"], "name": f["name"]} for f in find_mcp_config_secret_spans(text, file)]


def mask_mcp_values(text: str, spans: List[Dict[str, object]]) -> str:
    """The text with each found value replaced, so no other rule can print it.
    Line numbers do not change."""
    out = []
    last = 0
    for sp in sorted(spans, key=lambda f: (int(f["start"]), -int(f["end"]))):
        if int(sp["start"]) < last:
            continue
        out.append(text[last:int(sp["start"])])
        out.append("[REDACTED_MCP]")
        last = int(sp["end"])
    out.append(text[last:])
    return "".join(out)


def _pair(name: str, value: str, at: int, add: _AddFn, own_login: bool) -> None:
    norm = normalize_name(name)
    end = at + len(value)
    if is_secret_name(norm):
        if own_login and norm in _OWN_LOGIN_NAMES:
            return
        if _holds_credential(value, True):
            if norm in _HEADER_NAMES:
                kind = "header"
            elif re.fullmatch(r"[A-Z0-9_]+", name):
                kind = "environment variable"
            else:
                kind = "setting"
            add(kind, name, at, end)
            return
    elif _SCHEME_VALUE.fullmatch(value) and _holds_credential(value, True):
        add("header", name, at, end)
        return
    for norm_p, off, ln_ in _url_params(value):
        add("URL", norm_p, at + off, at + off + ln_)


def _argument(s: str, at: int, add: _AddFn, set_pending: Callable[[str], None]) -> None:
    short = len(s) <= 4096
    eq = _FLAG_EQ.fullmatch(s) if short else None
    if eq:
        value_at = at + len(eq.group(1)) + 1
        if is_secret_name(normalize_name(eq.group(1))):
            if _holds_credential(eq.group(2), False):
                add("argument", eq.group(1).lstrip("-"), value_at, at + len(s))
            return
        # --header=Authorization: Bearer value
        hv = _HEADER_ARG.fullmatch(eq.group(2))
        if hv and _holds_credential(hv.group(2), True):
            add("header", hv.group(1), at + len(s) - len(hv.group(2)), at + len(s))
        return
    if _FLAG.fullmatch(s):
        if is_secret_name(normalize_name(s)):
            set_pending(s.lstrip("-"))
        return
    h = _HEADER_ARG.fullmatch(s) if short else None
    if h:
        if _holds_credential(h.group(2), True):
            add("header", h.group(1), at + len(s) - len(h.group(2)), at + len(s))
        return
    for norm_p, off, ln_ in _url_params(s):
        add("URL", norm_p, at + off, at + off + ln_)


def mcp_sample(kind: str, name: str) -> str:
    if kind == "argument":
        return f"{name} [REDACTED]"
    if kind == "URL":
        return f"URL parameter {name}=[REDACTED]"
    return f"{name} = [REDACTED]"


def mcp_reason(kind: str) -> str:
    return f"Plaintext credential in an MCP server configuration ({kind})"


def mcp_next_step(kind: str, name: str) -> str:
    use = suggested_name(normalize_name(name))
    if kind in ("header", "URL"):
        return ("Next: take the value out of this file and refer to an environment variable instead, written the way "
                "your agent expects (for example ${" + use + "} in Claude Code, ${env:" + use + "} in Cursor and VS Code, "
                "{env:" + use + "} in OpenCode), keep the real value in your own shell settings or a secret manager, "
                "and rotate it if the file was ever committed or shared.")
    return (f"Next: run npx -y zn-gate secret set {use} to store the value in the local vault (it asks for the value, "
            f"so it is never typed on a command line), run zn secret allow {use} --command <the server's command> so zn run "
            f"may use it, put __ZN_{use}__ in this file instead, start the server "
            "through zn run (see docs/secrets.md), and rotate the value if the file was ever committed or shared.")
