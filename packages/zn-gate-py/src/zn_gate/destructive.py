"""
Optional policy for destructive shell commands (Python twin of lib/destructive.js).

check_command() looks at one shell command (Bash, sh, zsh or PowerShell text) and
blocks only a few narrow shapes:

  rm_root_home     recursive delete of the home folder, the filesystem root, a
                   top-level system folder or a drive root
  pipe_to_shell    a download that is run as a script without being read
  disk_overwrite   dd, mkfs, wipefs ... on a block device, or a redirect to one
  perm_root        chmod -R 777 or chown -R on the root or a system folder
  fork_bomb        the classic shell fork bomb
  rc_download      a download written into a shell startup file

It is a guardrail against a model's mistake or a bad suggestion, not a sandbox: a
command built at run time (rm -rf "$DIR" with an empty variable, a script file the
agent wrote and then runs) is not seen. Calling check_command() is the opt-in: it
always applies the policy. Pure Python stdlib.

The Node.js and Python versions give the same answer on the shared test corpus
(packages/zn-gate/test/fixtures/destructive_commands.json).
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

from .rules import Assessment

COMMAND_RULES_VERSION = "2026-10-28.4"

_REASONS = {
    "rm_root_home": "it deletes the home folder, the filesystem root or a system folder, recursively",
    "pipe_to_shell": "it downloads a script and runs it without anyone reading it first",
    "disk_overwrite": "it writes to or formats a disk device",
    "perm_root": "it changes permissions or owners across the whole filesystem or a system folder",
    "fork_bomb": "it is a fork bomb, which freezes the machine",
    "rc_download": "it writes downloaded content into a shell startup file, which runs in every new terminal",
}

_MAX_DEPTH = 3
# Same limit as the policy's own tokenizer: enough simple commands for any text under the shell scan cap.
_MAX_SEGMENTS = 50000
_OVERFLOW = "too_many_commands"
_OVERFLOW_REASON = "it has more commands than can be checked, so it is refused rather than guessed at"
_MAX_CHARS = 200 * 1024
_QUOTE_SCAN_MAX = 20000
_A = re.ASCII
_AI = re.ASCII | re.IGNORECASE

_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "rbash"}
_POWERSHELLS = {"pwsh", "powershell"}
_DOWNLOADERS = {"curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "aria2c", "fetch"}
_RM_HEADS = {"rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"}
_CMD_HEADS = {"rd", "rmdir", "del", "erase"}
_DISK_TOOLS = re.compile(r"^(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|mkswap|wipefs|shred|blkdiscard)$")
# find actions that run a program on each file, and the programs that delete it.
_FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}
_DELETERS = re.compile(r"^(?:rm|shred|unlink)\Z")
# xargs options that take the next word as their value.
_XARGS_VALUE = {"-I", "-n", "-P", "-L", "-s", "-d", "-E", "-e", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--replace", "--eof"}
# git options before the subcommand that take the next word as their value.
_GIT_VALUE = {"-c", "--namespace", "--config-env", "--super-prefix", "--exec-path", "--git-dir"}
_SUDO_ARG_FLAGS = {"-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "-U", "-D", "-R"}

_SYSTEM_DIRS = {
    "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/opt", "/proc", "/root",
    "/sbin", "/srv", "/sys", "/usr", "/var", "/Users", "/System", "/Library", "/Applications", "/private", "/Volumes",
}
_HOME_WORDS = {
    "~", "$home", "${home}", "$userprofile", "${userprofile}", "%userprofile%", "$env:userprofile", "$env:home", "$env:homepath",
}
_BLOCK_DEVICE_RE = re.compile(
    r"^/dev/(?:sd[a-z]+\d*|hd[a-z]+\d*|vd[a-z]+\d*|xvd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|disk\d+(?:s\d+)?|rdisk\d+(?:s\d+)?|md\d+|dm-\d+|mapper/[A-Za-z0-9._-]+)\Z",
    _A,
)
_RC_UNIX_RE = re.compile(
    r"/\.(?:bashrc|bash_profile|bash_login|bash_aliases|profile|zshrc|zprofile|zshenv|zlogin|kshrc|cshrc|tcshrc)\Z"
    r"|/fish/config\.fish\Z|^/etc/(?:profile|bash\.bashrc|zshrc|zsh/zshrc|environment)\Z|^/etc/profile\.d/",
    _A,
)
_RC_PS_RE = re.compile(r"^\$profile(?:\.\w+)?\Z|(?:^|[\\/])(?:microsoft\.powershell_)?profile\.ps1\Z", _AI)

_QUOTED_RE = re.compile(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"")
_FORK_BOMB_RE = re.compile(r"(?<![\w:])([A-Za-z_:][\w:]*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1(?!\w)", _A)
_SHELL_RUNS_DOWNLOAD_RE = re.compile(
    r"(?:^|[\s;&|(])(?:eval|(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c)\s+[\"']?(?:\$\(|`)\s*(?:curl|wget)\b", _A
)
_SOURCE_DOWNLOAD_RE = re.compile(
    r"(?:^|[\s;&|(])(?:source|\.|(?:ba|z|da|k)?sh)\s+(?:-\w+\s+)*<\(\s*(?:curl|wget)\b", _A
)
_PS_PIPE_RE = re.compile(
    r"\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^|;\n]{0,300}\|\s*(?:iex|invoke-expression)\b"
    r"|\bdownloadstring\([^)]{0,300}\)\s*\|\s*(?:iex|invoke-expression)\b",
    _AI,
)
_PS_CALL_RE = re.compile(
    r"(?:^|[\s;&|(])(?:iex|invoke-expression)\b[\s($]*(?:\(\s*)*(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|new-object\s+(?:system\.)?net\.webclient)\b",
    _AI,
)
# PowerShell escapes a character with a backtick (i`wr, Invoke-`Expression). Only a backtick inside a word counts: in
# POSIX shells a backtick starts a command substitution, so the text is never stripped for the other patterns.
_PS_TICK_RE = re.compile(r"(?:(?<=[\s|;&(A-Za-z0-9_.-])|^)`(?=[A-Za-z-])", _A)
_PS_LINE_TICK_RE = re.compile(r"`\r?\n")
_PS_DISK_RE = re.compile(r"(?:^|[\s;&|(])(?:format-volume|clear-disk)\b", _AI)

_ANSI_C_RE = re.compile(r"\$'((?:[^'\\]|\\[\s\S])*)'")
_ANSI_C_ESC_RE = re.compile(r"\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])")
_ANSI_C_SIMPLE = {
    "a": "\x07", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v",
    "\\": "\\", "'": "'", '"': '"', "?": "?",
}

_ESCAPABLE = set("\\\"'`$ \t;&|()<>\n#*?[]{}~")
_DQ_ESCAPABLE = set('"\\$`\n')


def _program_name(text: str) -> str:
    name = re.sub(r"^\\+", "", str(text))
    name = re.split(r"[\\/]", name)[-1].lower()
    return re.sub(r"\.exe\Z", "", name)


def _scan_first(s: str, posix: bool = False) -> Tuple[int, List[str], Optional[str]]:
    """The first simple command of s, like scanFirstCommand in lib/hooks/policy.js (backslash read as a Windows path separator)."""
    words: List[str] = []
    cur: Optional[List[str]] = None
    quote: Optional[str] = None
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if quote == "'":
            if ch == "'":
                quote = None
            else:
                cur.append(ch)  # type: ignore[union-attr]
            i += 1
            continue
        if quote == '"':
            if ch == "\\" and i + 1 < n:
                if s[i + 1] not in _DQ_ESCAPABLE:
                    cur.append(ch)  # type: ignore[union-attr]
                    i += 1
                    continue
                cur.append(s[i + 1])  # type: ignore[union-attr]
                i += 2
                continue
            if ch == '"':
                quote = None
                i += 1
                continue
            cur.append(ch)  # type: ignore[union-attr]
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            if s[i + 1] == "\n":
                i += 2
                continue
            if not posix and s[i + 1] not in _ESCAPABLE:
                if cur is None:
                    cur = []
                cur.append(ch)
                i += 1
                continue
            if cur is None:
                cur = []
            cur.append(s[i + 1])
            i += 2
            continue
        if ch in ("'", '"'):
            quote = ch
            if cur is None:
                cur = []
            i += 1
            continue
        if ch == "`" or (ch == "$" and i + 1 < n and s[i + 1] == "("):
            if cur is None:
                cur = []
            cur.append(ch)
            i += 1
            continue
        if ch in ";&|\n()":
            if cur is not None:
                words.append("".join(cur))
            return i, words, ch
        if ch in " \t":
            if cur is not None:
                words.append("".join(cur))
                cur = None
            i += 1
            continue
        if cur is None:
            cur = []
        cur.append(ch)
        i += 1
    if cur is not None:
        words.append("".join(cur))
    return n, words, None


def _decode_ansi_c(cmd: str) -> str:
    """The command with each bash $'...' word decoded and quoted again as a plain '...' word, and $"..." read as "..."."""

    def esc(m: "re.Match[str]") -> str:
        x = m.group(1)
        if x[0] in "xuU":
            n = int(x[1:], 16)
            return chr(n) if n <= 0x10FFFF else ""
        if x[0] in "01234567":
            return chr(int(x, 8) & 0xFF)
        if x[0] == "c" and len(x) == 2:
            return chr(ord(x[1]) & 0x1F)
        return _ANSI_C_SIMPLE.get(x, "\\" + x)

    def word(m: "re.Match[str]") -> str:
        # Bash ends the string at the first NUL character.
        text = _ANSI_C_ESC_RE.sub(esc, m.group(1)).split("\0")[0]
        return "'" + text.replace("'", "'\\''") + "'"

    return _ANSI_C_RE.sub(word, cmd).replace('$"', '"')


def _segments_of(cmd: str, posix: bool = False) -> Tuple[List[Tuple[List[str], Optional[str]]], bool]:
    rest = re.sub(r"(\d*[<>]+)&(\d+|-)", r"\1_\2", str(cmd), flags=_A)
    rest = re.sub(r"&>>?", ">", rest)
    # A drive root C:\ before a space is a path, not an escaped space.
    rest = re.sub(r"(^|[\s\"'])([A-Za-z]:)\\(?=\s|\Z)", r"\1\2/", rest)
    out: List[Tuple[List[str], Optional[str]]] = []
    guard = 0
    while rest and guard < _MAX_SEGMENTS:
        guard += 1
        end, words, sep = _scan_first(rest, posix)
        adv = end + 1
        if sep in ("|", "&"):
            nxt = rest[end + 1] if end + 1 < len(rest) else ""
            if nxt == sep:
                sep += sep
                adv += 1
            elif sep == "|" and nxt == "&":
                sep = "|&"
                adv += 1
        out.append((words, sep))
        rest = rest[adv:]
    # Unread text left over: the caller must not treat the commands read so far as the whole line.
    return out, bool(rest)


def _is_pipe(sep: Optional[str]) -> bool:
    return sep in ("|", "|&")


def _unwrap(args: List[str]) -> List[str]:
    i = 0
    guard = 0
    while guard < 8 and i < len(args):
        guard += 1
        a = args[i]
        if _ASSIGN_RE.match(a):
            i += 1
            continue
        # A brace group ({ rm -rf ~; }) or a subshell runs the command after it.
        if a in ("{", "("):
            i += 1
            continue
        name = _program_name(a)
        if name in ("sudo", "doas"):
            i += 1
            while i < len(args) and args[i].startswith("-"):
                f = args[i]
                i += 1
                if f in _SUDO_ARG_FLAGS:
                    i += 1
            continue
        if name == "env":
            i += 1
            while i < len(args) and (args[i].startswith("-") or _ASSIGN_RE.match(args[i])):
                f = args[i]
                i += 1
                if f in ("-u", "-C", "-S"):
                    i += 1
            continue
        if name in ("command", "exec", "nohup", "time", "builtin", "setsid"):
            i += 1
            while i < len(args) and args[i].startswith("-"):
                i += 1
            continue
        if name in ("nice", "ionice"):
            i += 1
            while i < len(args) and args[i].startswith("-"):
                f = args[i]
                i += 1
                if f in ("-n", "-c"):
                    i += 1
            continue
        # stdbuf -o0 / -o 0 rm ...; busybox and toybox run the applet named next (busybox rm -rf ~).
        if name == "stdbuf":
            i += 1
            while i < len(args) and args[i].startswith("-"):
                f = args[i]
                i += 1
                if re.match(r"^-[ioe]\Z", f):
                    i += 1
            continue
        if name in ("busybox", "toybox"):
            i += 1
            continue
        if name == "timeout":
            i += 1
            while i < len(args) and args[i].startswith("-"):
                i += 1
            i += 1
            continue
        break
    return args[i:]


def _resolve_dots(t: str) -> str:
    """Resolve "." and ".." lexically (no filesystem) for a path that starts at "/", a drive or a home word.
    A ".." above "/" or a drive root stays there; a ".." out of the home folder names its parent. Relative paths are left alone."""
    if not re.search(r"(?:^|/)\.\.?(?:/|\Z)", t):
        return t
    home = False
    drive = re.match(r"^[A-Za-z]:(?:/|\Z)", t)
    if t.startswith("/"):
        anchor, rest = "/", t[1:]
    elif drive:
        anchor, rest = t[:2] + "/", t[drive.end():]
    else:
        first = t.split("/")[0]
        if first.lower() not in _HOME_WORDS:
            return t
        anchor, rest, home = first + "/", t[len(first) + 1:], True
    out = []
    for seg in rest.split("/"):
        if seg in ("", "."):
            continue
        if seg != "..":
            out.append(seg)
        elif out:
            out.pop()
        elif home:
            return "/home"
    return anchor + "/".join(out)


def _dangerous_path(word: str) -> str:
    """'root', 'home' or 'system' for a path this policy protects, else ''."""
    t = re.sub(r"/{2,}", "/", str(word).replace("\\", "/"))
    if not t:
        return ""
    t = _resolve_dots(t)
    for _ in range(4):
        s = re.sub(r"/(?:\*|\.\*|\.|\{\*,\.\*\})?\Z", "", t, count=1)
        if s == t and len(t) > 1 and t.endswith("*"):
            s = t[:-1]
        if s == t:
            break
        t = s
        if t == "":
            return "root"
    if t == "*":
        return ""
    if t.lower() in _HOME_WORDS:
        return "home"
    # ~name is the home folder of the account `name`.
    if re.match(r"^~[A-Za-z0-9._-]+\Z", t):
        return "home"
    if t in _SYSTEM_DIRS:
        return "system"
    if re.match(r"^/(?:home|Users)/[^/*.][^/*]*\Z", t):
        return "home"
    if re.match(r"^[A-Za-z]:\Z", t):
        return "root"
    if re.match(r"^[A-Za-z]:/(?:windows|windows/system32|users|program files|program files \(x86\)|programdata)\Z", t, re.I):
        return "system"
    if re.match(r"^[A-Za-z]:/users/[^/*]+\Z", t, re.I):
        return "home"
    return ""


def _recursive_flag(w: str, head: str) -> bool:
    if re.match(r"^-[fiIrRdvx]*[rR][fiIrRdvx]*\Z", w) or w == "--recursive":
        return True
    if re.match(r"^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\Z", w, re.I):
        return True
    return head in _CMD_HEADS and re.match(r"^/s\Z", w, re.I) is not None


def _is_cmd_flag(w: str, head: str) -> bool:
    return head in _CMD_HEADS and re.match(r"^/[sqfaA]\Z", w) is not None


def _operands(args: List[str], head: str) -> List[str]:
    out: List[str] = []
    rest = False
    for w in args:
        if not rest and w == "--":
            rest = True
            continue
        if not rest and (w.startswith("-") or _is_cmd_flag(w, head)):
            continue
        out.append(w)
    return out


def _redirect_targets(words: List[str]) -> List[str]:
    out: List[str] = []
    for i, w in enumerate(words):
        if re.match(r"^\d*>>?\|?\Z", w, _A):
            if i + 1 < len(words):
                out.append(words[i + 1])
            continue
        m = re.match(r"^\d*>>?\|?(.+)\Z", w, _A | re.S)
        if m:
            out.append(m.group(1))
    return out


def _world_writable(mode: str) -> bool:
    if re.match(r"^0?[0-7]{2}[2367]\Z", mode) or (re.match(r"^[0-7]{4}\Z", mode) and mode[-1] in "2367"):
        return True
    m = re.match(r"^([ugoa]*)[+=][rwxXst]*w[rwxXst]*\Z", mode)
    return bool(m and (m.group(1) == "" or re.search(r"[ao]", m.group(1))))


# The options find takes before its paths: -H, -L, -P (links), -D <debug options> and -O<level>.
_FIND_GLOBAL_RE = re.compile(r"^-(?:[HLP]+|D|O\d*)\Z")


def _find_paths(args: List[str]) -> List[str]:
    """The paths a find command starts from: the words before its first option or
    expression, after its leading options."""
    paths: List[str] = []
    i = 0
    while i < len(args) and _FIND_GLOBAL_RE.match(args[i]):
        i += 2 if args[i] == "-D" else 1
    for w in args[i:]:
        if w.startswith("-") or w == "(" or w == "!":
            break
        paths.append(w)
    return paths


def _xargs_command(args: List[str]) -> List[str]:
    """The command xargs runs: its words from the first one that is neither an option nor an option's value."""
    i = 0
    while i < len(args):
        w = args[i]
        if w == "--":
            return args[i + 1:]
        if w in _XARGS_VALUE:
            i += 2
            continue
        if w.startswith("-"):
            i += 1
            continue
        return args[i:]
    return []


def _runs_deleter(words: List[str], depth: int = 0) -> bool:
    """Whether the command `words` (run by xargs or find -exec) deletes: rm, shred or unlink, also behind
    a wrapper (sudo, env, nice, timeout ...) or as the first command of the code of sh -c."""
    u = _unwrap(words)
    head = _program_name(u[0] if u else "")
    if _DELETERS.match(head):
        return True
    if head in _SHELLS and depth < _MAX_DEPTH:
        k = next((j for j, w in enumerate(u) if re.match(r"^-[A-Za-z]*c[A-Za-z]*\Z", w)), -1)
        if k > 0 and k + 1 < len(u):
            return _runs_deleter(u[k + 1].split(), depth + 1)
    return False


def _git_clean_danger(args: List[str]) -> bool:
    """git ... clean with -f (not -n or -i) on a home, root or system folder: given with -C or --work-tree, or as a path."""
    dirs: List[str] = []
    i = 0
    while i < len(args):
        w = args[i]
        if w in ("-C", "--work-tree"):
            dirs.append(args[i + 1] if i + 1 < len(args) else "")
            i += 2
            continue
        if w.startswith("--work-tree="):
            dirs.append(w[len("--work-tree="):])
            i += 1
            continue
        if w in _GIT_VALUE:
            i += 2
            continue
        if w.startswith("-"):
            i += 1
            continue
        break
    if i >= len(args) or args[i] != "clean":
        return False
    sub = args[i + 1:]
    flags = [w for w in sub if w.startswith("-") and w != "--"]
    force = any(re.match(r"^-[A-Za-z]*f", w) or w == "--force" for w in flags)
    dry = any(re.match(r"^-[A-Za-z]*[ni]", w) or w in ("--dry-run", "--interactive") for w in flags)
    return force and not dry and any(_dangerous_path(w) for w in dirs + _operands(sub, "git"))


def _check_simple(words: List[str], depth: int) -> Optional[str]:
    args = _unwrap(words)
    if not args:
        return None
    head = _program_name(args[0])
    rest = args[1:]

    code: Optional[str] = None
    if head in _SHELLS or head == "su":
        k = next((j for j, w in enumerate(rest) if re.match(r"^-[A-Za-z]*c[A-Za-z]*\Z", w)), -1)
        if k >= 0 and k + 1 < len(rest):
            code = rest[k + 1]
    elif head == "eval":
        code = " ".join(rest)
    elif head in _POWERSHELLS:
        k = next((j for j, w in enumerate(rest) if re.match(r"^-c(?:ommand)?\Z", w, re.I)), -1)
        if k >= 0:
            code = " ".join(rest[k + 1:])
    elif head == "cmd":
        k = next((j for j, w in enumerate(rest) if re.match(r"^/[ck]\Z", w, re.I)), -1)
        if k >= 0:
            code = " ".join(rest[k + 1:])
    if code is not None and depth < _MAX_DEPTH:
        hit = _analyze(code, depth + 1)
        if hit:
            return hit

    if head in _RM_HEADS:
        if any(_recursive_flag(w, head) for w in rest) and any(_dangerous_path(w) for w in _operands(rest, head)):
            return "rm_root_home"
    if head == "find":
        # A test (-name, -type, -mtime ...) does not make it safe: -name '*' matches every file below the path.
        delete = "-delete" in rest or any(
            w in _FIND_EXEC and _runs_deleter(rest[j + 1:])
            for j, w in enumerate(rest)
        )
        if delete and any(_dangerous_path(w) for w in _find_paths(rest)):
            return "rm_root_home"
    if head == "git" and _git_clean_danger(rest):
        return "rm_root_home"
    if head in ("chmod", "chown", "chgrp"):
        if any(re.match(r"^-[A-Za-z]*R[A-Za-z]*\Z", w) or w == "--recursive" for w in rest):
            ops = _operands(rest, head)
            mode = ops[0] if ops else ""
            targets = [d for d in (_dangerous_path(w) for w in ops[1:]) if d]
            if "root" in targets or "system" in targets:
                return "perm_root"
            if head == "chmod" and "home" in targets and _world_writable(mode):
                return "perm_root"
    if head == "dd":
        if any(w.startswith("of=") and _BLOCK_DEVICE_RE.match(w[3:]) for w in rest):
            return "disk_overwrite"
    if _DISK_TOOLS.match(head) and any(_BLOCK_DEVICE_RE.match(w) for w in rest):
        return "disk_overwrite"
    return None


def _is_rc_path(w: str) -> bool:
    t = str(w).replace("\\", "/")
    t = re.sub(r"^~/", "/", t)
    t = re.sub(r"^\$\{?home\}?/", "/", t, flags=re.I)
    return bool(_RC_UNIX_RE.search(t) or _RC_PS_RE.search(str(w)))


def _out_flag(w: str) -> bool:
    return bool(
        re.match(r"^-[A-Za-z]*[oO]\Z", w)
        or re.match(r"^--output(?:-document)?\Z", w)
        or re.match(r"^-out(?:f(?:i(?:l(?:e)?)?)?)?\Z", w, re.I)
    )


# The first comma is matched by [^{},]*, so the pattern has one way to match and cannot backtrack.
_BRACE_RE = re.compile(r"\{([^{},]*,[^{}]*)\}")


# A brace list has at least two alternatives, so more than 6 lists in one word always pass the default limit of 64.
# The recursion stops there instead of following one level per list (2000 lists overflowed the stack).
_BRACE_MAX_DEPTH = 8


def _expand_braces(s: str, limit: int = 64, depth: int = 0) -> Optional[List[str]]:
    """Alternatives of a word with brace lists (a{b,c} -> ab, ac); None when there are too many."""
    m = _BRACE_RE.search(s)
    if not m:
        return [s]
    if depth >= _BRACE_MAX_DEPTH:
        return None
    out: List[str] = []
    for alt in m.group(1).split(","):
        rest = _expand_braces(s[:m.start()] + alt + s[m.end():], limit, depth + 1)
        if rest is None:
            return None
        for x in rest:
            out.append(x)
            if len(out) > limit:
                return None
    return out


_SEQ_RE = re.compile(r"\{(?:([A-Za-z])\.\.([A-Za-z])|(\d{1,2})\.\.(\d{1,2}))\}")


def _expand_seq(m: "re.Match[str]") -> str:
    a, b, n, k = m.groups()
    is_chr = a is not None
    if is_chr:
        if (a < "a") != (b < "a"):
            return m.group(0)  # mixed case: bash also walks the characters between, not worth following
        start, end = ord(a), ord(b)
    else:
        start, end = int(n), int(k)
    step = 1 if start <= end else -1
    items = [chr(c) if is_chr else str(c) for c in range(start, end + step, step)]
    return items[0] if len(items) == 1 else "{" + ",".join(items) + "}"


def _brace_alts(w: str) -> Optional[List[str]]:
    """The words a brace list in `w` expands to (c{u,}rl -> curl, cl), `{x..y}` with one-character or short
    numeric ends included; just `w` when there is none, and None when there are too many: the caller reads that
    as a match, since the shell runs the first alternative and any of them may be it."""
    return _expand_braces(_SEQ_RE.sub(_expand_seq, str(w)))


def _check_pipeline(pipe: List[Tuple[List[str], Optional[str]]]) -> Optional[str]:
    heads = []
    for words, _sep in pipe:
        a = _unwrap(words)
        alts = _brace_alts(a[0]) if a else [""]
        names = [_program_name(x) for x in (alts if alts is not None else [str(a[0])])]
        heads.append((a, names[0], names, alts is None))
    first_dl = next((j for j, h in enumerate(heads) if h[3] or any(n in _DOWNLOADERS for n in h[2])), -1)
    if first_dl >= 0:
        for j in range(first_dl + 1, len(pipe)):
            args, head, names, overflow = heads[j]
            if not overflow and not any(n in _SHELLS for n in names):
                continue
            rest = args[1:]
            if any(re.match(r"^-[A-Za-z]*[cn][A-Za-z]*\Z", w) for w in rest):
                continue
            files = [w for w in rest if not w.startswith("-")]
            if not files or "-s" in rest or "-" in rest:
                return "pipe_to_shell"
        for j, (words, _sep) in enumerate(pipe):
            for i, w in enumerate(words):
                prev = words[i - 1] if i > 0 else ""
                target: Optional[str] = None
                if re.match(r"^\d*>>?\|?\Z", prev, _A):
                    target = w
                elif re.match(r"^\d*>>?\|?.+\Z", w, _A | re.S):
                    target = re.sub(r"^\d*>>?\|?", "", w, count=1, flags=_A)
                elif _out_flag(prev):
                    target = w
                elif re.match(r"^(?:--output|--output-document|-OutFile)[=:]", w, re.I):
                    target = re.sub(r"^[^=:]*[=:]", "", w, count=1)
                elif heads[j][1] == "tee" and not w.startswith("-") and i > 0:
                    target = w
                if target is not None:
                    alts = _brace_alts(target)
                    if alts is None or any(_is_rc_path(t) for t in alts):
                        return "rc_download"
    # find on a home, root or system folder whose list goes to xargs rm (with -print0 and xargs -0 too).
    find_at = next((j for j, h in enumerate(heads) if h[1] == "find" and any(_dangerous_path(w) for w in _find_paths(h[0][1:]))), -1)
    if find_at >= 0:
        for j in range(find_at + 1, len(pipe)):
            if heads[j][1] == "xargs" and _runs_deleter(_xargs_command(heads[j][0][1:])):
                return "rm_root_home"
    for words, _sep in pipe:
        for t in _redirect_targets(words):
            if _BLOCK_DEVICE_RE.match(t):
                return "disk_overwrite"
    return None


def _check_segments(segs: List[Tuple[List[str], Optional[str]]], depth: int) -> Optional[str]:
    pipe: List[Tuple[List[str], Optional[str]]] = []
    for words, sep in segs:
        hit = _check_simple(words, depth)
        if hit:
            return hit
        pipe.append((words, sep))
        if not _is_pipe(sep):
            hit2 = _check_pipeline(pipe)
            if hit2:
                return hit2
            pipe = []
    return _check_pipeline(pipe) if pipe else None


def _analyze(cmd: str, depth: int = 0) -> Optional[str]:
    # A carriage return splits words like a space does in PowerShell and cmd.exe, so it is read as one.
    text = str(cmd).replace("\r", " ")
    if len(text) > _MAX_CHARS:
        return _OVERFLOW
    bare = text if len(text) > _QUOTE_SCAN_MAX else _QUOTED_RE.sub("''", text)
    if _FORK_BOMB_RE.search(bare):
        return "fork_bomb"
    ps_bare = _PS_TICK_RE.sub("", _PS_LINE_TICK_RE.sub(" ", bare)) if "`" in bare else bare
    if (
        _SHELL_RUNS_DOWNLOAD_RE.search(text)
        or _SOURCE_DOWNLOAD_RE.search(bare)
        or _PS_PIPE_RE.search(ps_bare)
        or _PS_CALL_RE.search(ps_bare)
    ):
        return "pipe_to_shell"
    if _PS_DISK_RE.search(bare):
        return "disk_overwrite"
    segs, truncated = _segments_of(text)
    hit = _check_segments(segs, depth)
    if hit:
        return hit
    # POSIX reading: an unquoted backslash escapes the next character and is removed (r\m, cu\rl, .bash\rc). The Windows
    # reading above keeps it as a path separator and runs first, so this one only adds blocks: any rule it hits counts.
    if "\\" in text:
        posix_hit = _check_segments(_segments_of(text, True)[0], depth)
        if posix_hit:
            return posix_hit
    # ANSI-C quoting: bash reads $'\x63url' as curl. The words are decoded the way bash does, then read again; as above,
    # this reading only adds a block, and only for the two rules that name a program or a file ($'\x73h', $'.bash\x72c').
    if "$'" in text:
        ansi_hit = _check_segments(_segments_of(_decode_ansi_c(text), True)[0], depth)
        if ansi_hit in ("pipe_to_shell", "rc_download"):
            return ansi_hit
    # Fail closed: never allow a line whose tail was not read.
    return _OVERFLOW if truncated else None


def check_command(command: str) -> Assessment:
    """
    Check one shell command (Bash, sh, zsh or PowerShell text) against the destructive-command policy.
    Returns an Assessment: verdict 'block' with rule 'destructive:<name>' for one of the narrow shapes
    listed in this module's docstring, else 'allow'.
    """
    hit = _analyze(command, 0) if isinstance(command, str) else None
    if not hit:
        return Assessment(verdict="allow", confidence=1.0, rule="none", reason=None, rules_version=COMMAND_RULES_VERSION)
    return Assessment(
        verdict="block",
        confidence=0.95,
        rule="destructive:" + hit,
        reason="Destructive command: " + (_REASONS.get(hit) or _OVERFLOW_REASON),
        rules_version=COMMAND_RULES_VERSION,
    )
