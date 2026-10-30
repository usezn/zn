"""
Optional policy for destructive shell commands (Python twin of lib/destructive.js).

check_command() looks at one shell command (Bash, sh, zsh or PowerShell text) and
blocks only a few narrow shapes:

  rm_root_home     recursive delete of the home folder, the filesystem root, a
                   top-level system folder or a drive root
  pipe_to_shell    a download that is run as a script (or by python, node, perl or ruby) without being read
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
from typing import Any, Dict, FrozenSet, List, NamedTuple, Optional, Pattern, Tuple

from .rules import Assessment

COMMAND_RULES_VERSION = "2026-10-30.5"

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
_FIND_TESTS = re.compile(
    r"^-(?:i?name|i?path|i?wholename|i?regex|type|[acm]time|[acm]min|newer\w*|size|user|group|perm|empty|links|inum|samefile|executable|readable|writable|uid|gid)$",
    _A,
)
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
# The downloader inside the substitution may be written \curl, env curl, command -p curl or /usr/bin/curl, and the shell
# /bin/sh or env sh. Every quantifier below is over a class that cannot also match the separator after it, so the scan is linear.
_SUBST_DL = r"(?:(?:env|command|exec|nohup)\s+(?:(?:-\S*|\w+=\S*)\s+)*)?\\?(?:[\w.~-]*/)*(?:curl|wget)\b"
_SUBST_SHELL = r"(?:[\w.~-]*/)*(?:ba|z|da|k)?sh"
_SHELL_RUNS_DOWNLOAD_RE = re.compile(
    r"(?:^|[\s;&|(])(?:eval|" + _SUBST_SHELL + r"\s+(?:-\w+\s+)*-\w*c)\s+[\"']?(?:\$\(|`)\s*" + _SUBST_DL, _A
)
_SOURCE_DOWNLOAD_RE = re.compile(
    r"(?:^|[\s;&|(])(?:source|\.|" + _SUBST_SHELL + r")\s+(?:-\w+\s+)*<\(\s*" + _SUBST_DL, _A
)
# After a pipe the next command may follow a line break or be a group: curl URL |<nl>sh, curl URL | (sh).
_PIPE_LEAD_RE = re.compile(r"(?:\s|\()+", _A)
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
_PS_NEXT_PIPE_RE = re.compile(r"\r?\n[ \t]*\|")
_PS_DISK_RE = re.compile(r"(?:^|[\s;&|(])(?:format-volume|clear-disk)\b", _AI)

# Code an interpreter runs from its command line (python -c, node -e, perl -e, ruby -e) and a download piped into one.
# Every quantifier is bounded, so the scan over the code is linear.
_INTERPRETER_RE = re.compile(r"^(?:py|python(?:[23](?:\.\d+)?)?|pypy3?|node(?:js)?|perl|ruby)\Z", _A)
class _InterpSpec(NamedTuple):
    """How one interpreter family takes code and options on its command line."""

    skip: FrozenSet[str]
    code: Pattern[str]
    no_stdin: Pattern[str]


_INTERPRETERS: Dict[str, _InterpSpec] = {
    "py": _InterpSpec(
        skip=frozenset({"-W", "-X"}),
        code=re.compile(r"^-[A-Za-z]*c\Z", _A),
        no_stdin=re.compile(r"^(?:-[A-Za-z]*[cmVh][A-Za-z]*|--(?:version|help))\Z", _A),
    ),
    "node": _InterpSpec(
        skip=frozenset({"-r", "--require", "--import", "--loader", "--experimental-loader"}),
        code=re.compile(r"^(?:-e|-p|-pe|--eval|--print)\Z", _A),
        no_stdin=re.compile(r"^(?:-[A-Za-z]*[epcvh][A-Za-z]*|--(?:eval|print|check|version|help|test)(?:=.*)?)\Z", _A | re.S),
    ),
    "perl": _InterpSpec(
        skip=frozenset({"-I"}),
        code=re.compile(r"^-[A-Za-z]*[eE]\Z", _A),
        no_stdin=re.compile(r"^-[A-Za-z]*[eEcvVh][A-Za-z]*\Z", _A),
    ),
    "ruby": _InterpSpec(
        skip=frozenset({"-r", "-I"}),
        code=re.compile(r"^-[A-Za-z]*e\Z", _A),
        no_stdin=re.compile(r"^(?:-[A-Za-z]*[ecvh][A-Za-z]*|--(?:version|help))\Z", _A),
    ),
}
_NODE_EVAL_EQ_RE = re.compile(r"^--(?:eval|print)=([\s\S]*)\Z")
# A recursive-delete call: shutil.rmtree, fs.rmSync / rmdirSync / rm / rmdir, rimraf, File::Path remove_tree / rmtree,
# FileUtils.rm_rf / rm_r / remove_entry, and Perl's unlink glob(...).
_OI_CALL_RE = re.compile(
    r"\b(rmtree|remove_tree|remove_entry_secure|remove_entry|remove_dir|rm_rf|rm_r|rimraf|removeSync|rmSync|rmdirSync|rmdir|rm)\b"
    r"(?:\s{0,20}\.\s{0,20}sync\b)?\s{0,20}(\()?",
    _A,
)
_OI_GLOB_RE = re.compile(r"\bunlink\s{0,20}\(?\s{0,20}glob\b\s{0,20}\(?", _A)
_OI_NEEDS_PAREN = {"rimraf", "removeSync", "rmSync", "rmdirSync", "rmdir", "rm"}
_OI_NEEDS_RECURSIVE = {"rmSync", "rmdirSync", "rmdir", "rm"}
_OI_RECURSIVE_RE = re.compile(r"""\brecursive['"]?\s{0,20}:\s{0,20}(?:true|1|!0)""", _A)
_OI_PATH_WRAP_RE = re.compile(
    r"^(?:(?:pathlib\s{0,20}\.\s{0,20})?(?:Pure)?(?:Posix)?(?:Windows)?Path\s{0,20}\(\s{0,20}|(?:path|dirname|dir)\s{0,20}=\s{0,20})", _A
)
# The home folder named by an expression and not by a literal: expanduser('~'), os.homedir(), Path.home(), Dir.home, $ENV{HOME} ...
_OI_HOME_RE = re.compile(
    r"""^(?:(?:os\s{0,20}\.\s{0,20}path\s{0,20}\.\s{0,20})?expanduser\s{0,20}\(\s{0,20}['"]~/?['"]\s{0,20}\)"""
    r"""|(?:require\s{0,20}\(\s{0,20}['"](?:node:)?os['"]\s{0,20}\)\s{0,20}\.\s{0,20}|os\s{0,20}\.\s{0,20})?homedir\s{0,20}\(\s{0,20}\)"""
    r"""|(?:pathlib\s{0,20}\.\s{0,20})?Path\s{0,20}\.\s{0,20}home\s{0,20}\(\s{0,20}\)"""
    r"""|Dir\s{0,20}\.\s{0,20}home\b(?:\s{0,20}\(\s{0,20}\))?"""
    r"""|File\s{0,20}\.\s{0,20}expand_path\s{0,20}\(\s{0,20}['"]~/?['"]\s{0,20}\)"""
    r"""|ENV\s{0,20}\[\s{0,20}['"]HOME['"]\s{0,20}\]"""
    r"""|\$ENV\s{0,20}\{\s{0,20}['"]?HOME['"]?\s{0,20}\}"""
    r"""|os\s{0,20}\.\s{0,20}environ\s{0,20}\[\s{0,20}['"]HOME['"]\s{0,20}\]"""
    r"""|os\s{0,20}\.\s{0,20}(?:getenv|environ\s{0,20}\.\s{0,20}get)\s{0,20}\(\s{0,20}['"]HOME['"]\s{0,20}\)"""
    r"""|process\s{0,20}\.\s{0,20}env\s{0,20}(?:\.\s{0,20}HOME\b|\[\s{0,20}['"]HOME['"]\s{0,20}\]))""",
    _A,
)
_OI_AFTER_HOME_RE = re.compile(r"^\s{0,20}(?:[,)}\]]|\Z)", _A)
_OI_LITERAL_RE = re.compile(r"""^[rRbBuUfF]{0,2}(['"`])((?:[^'"`\\\r\n]|\\.){0,200})\1""", _A)
_OI_ENV_HOME_RE = re.compile(r"""\$ENV\{['"]?HOME['"]?\}|\$\{?HOME\}?|%USERPROFILE%""", _AI)

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
        if sep in ("|", "|&"):
            lead = _PIPE_LEAD_RE.match(rest)
            if lead:
                rest = rest[lead.end():]
    # Unread text left over: the caller must not treat the commands read so far as the whole line.
    return out, bool(rest)


def _is_pipe(sep: Optional[str]) -> bool:
    return sep in ("|", "|&")


# Literal variables assigned earlier on the same command line (X=curl; $X URL | sh, S=sh; curl URL | $S,
# T=~/.bashrc; curl URL >> $T, export X=curl). Nothing is evaluated: a value is text copied from an earlier assignment,
# and a variable not assigned on the line stays as it is. Linear and capped.
_MAX_ASSIGNMENTS = 256  # one more and the line is refused
_MAX_VALUE = 8192  # a longer value is not kept (the variable stays unknown)
_MAX_EXPANDED = 256 * 1024  # total text added by substitutions; past it the rest stays unresolved
_VAR_ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)\Z")
_VAR_REF_RE = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
_VAR_SOLE_REF_RE = re.compile(r"^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))\Z")
_DECLARERS = frozenset(("export", "declare", "typeset", "readonly", "local"))


def _join_backticks(words: List[str]) -> List[str]:
    """An assignment whose value is a `...` substitution is split into words by the tokenizer (X=`curl URL`): the words
    up to the closing backtick are joined into the value again. One pass."""
    out: List[str] = []
    changed = False
    i = 0
    while i < len(words):
        w = words[i]
        if _VAR_ASSIGN_RE.match(w) and w.count("`") % 2 == 1:
            changed = True
            while i + 1 < len(words) and w.count("`") % 2 == 1:
                i += 1
                w += " " + words[i]
        out.append(w)
        i += 1
    return out if changed else words


class _Vars:
    __slots__ = ("vars", "assignments", "expanded", "overflow")

    def __init__(self) -> None:
        self.vars: Dict[str, str] = {}
        self.assignments = 0
        self.expanded = 0
        self.overflow = False

    def substitute(self, word: str) -> str:
        if not self.vars or "$" not in word:
            return word

        def fill(m: "re.Match[str]") -> str:
            v = self.vars.get(m.group(1) or m.group(2))
            if v is None:
                return m.group(0)
            self.expanded += len(v)
            return m.group(0) if self.expanded > _MAX_EXPANDED else v

        return _VAR_REF_RE.sub(fill, word)

    def apply(self, words: List[str], sep: Optional[str]) -> List[str]:
        """The words of one simple command with the known variables filled in, and any assignment it makes recorded.
        An assignment in a pipe or a background command runs in a subshell and is not recorded."""
        out = words
        if self.vars:
            out = [self.substitute(w) for w in words]
            # A command word that is just a variable ($X url, | $S) is split on blanks, as an unquoted expansion is.
            if words:
                m = _VAR_SOLE_REF_RE.match(words[0])
                if m and (m.group(1) or m.group(2)) in self.vars:
                    out = out[0].split() + out[1:]
        if sep in ("|", "|&", "&"):
            return out
        out = _join_backticks(out)
        i = 0
        if out and out[0] in _DECLARERS:
            i = 1
            while i < len(out) and re.match(r"^-[A-Za-z]+\Z", out[i]):
                i += 1
        if i >= len(out):
            return out
        if not all(_VAR_ASSIGN_RE.match(w) for w in out[i:]):
            return out
        for w in out[i:]:
            m = _VAR_ASSIGN_RE.match(w)
            assert m is not None
            self.assignments += 1
            if self.assignments > _MAX_ASSIGNMENTS:
                self.overflow = True
                return out
            if len(m.group(2)) > _MAX_VALUE:
                self.vars.pop(m.group(1), None)
            else:
                self.vars[m.group(1)] = m.group(2)
        return out


# The wrappers that only run the next command, with the short options of each that take a value. One list for the
# download-and-run rule (here) and the egress check (Node only); it is the same table as the Node policy's.
_WRAPPERS = {
    "sudo": "ugphCDrtUTR", "doas": "uC", "env": "uCS", "command": "", "nohup": "", "time": "fo", "builtin": "", "exec": "a",
    "nice": "n", "timeout": "sk", "xargs": "IinLPdEsa", "setsid": "", "ionice": "cnpPu", "stdbuf": "ioe", "busybox": "",
    "chrt": "", "taskset": "c", "chroot": "ug", "runuser": "ugGsT", "unbuffer": "", "strace": "eopsuEaOSbPIX",
    "ltrace": "eopsunal", "nsenter": "tSG", "flock": "wE",
}
# Wrappers that take positional arguments before the command: chrt <priority>, taskset <mask> (not with -c), chroot <newroot>, flock <lock>.
_WRAPPER_POSITIONAL = {"chrt": 1, "taskset": 1, "chroot": 1, "flock": 1}
_WRAPPER_LONG_VALUE = frozenset((
    "--user", "--group", "--chdir", "--unset", "--max-args", "--max-procs", "--replace", "--delimiter", "--arg-file", "--eof",
    "--signal", "--kill-after", "--split-string", "--cpu-list", "--host", "--prompt", "--close-from", "--role", "--type",
))


def _skip_wrapper(words: List[str], k: int, name: str) -> int:
    """The index of the word after a wrapper and its options (and the values some take), env's assignments and timeout's duration."""
    value_opts = _WRAPPERS[name]
    saw_c = False
    k += 1
    while k < len(words):
        t = words[k]
        if t == "--":
            k += 1
            break
        if t.startswith("--") and len(t) > 2:
            k += 2 if "=" not in t and t in _WRAPPER_LONG_VALUE else 1
            continue
        if t.startswith("-") and len(t) > 1:
            if t == "-c":
                saw_c = True
            k += 2 if re.match(r"^-[A-Za-z]+\Z", t) and t[-1] in value_opts else 1
            continue
        if _ASSIGN_RE.match(t) or (name == "timeout" and re.match(r"^[0-9.]+[smhd]?\Z", t)):
            k += 1
            continue
        break
    if name in _WRAPPER_POSITIONAL and k < len(words) and not (name == "taskset" and saw_c):
        k += _WRAPPER_POSITIONAL[name]
    return k


# Words that start a command without being one: a group, the branches of if / while / until / for, and negation.
_SHELL_KEYWORDS = frozenset(("{", "then", "do", "else", "elif", "if", "while", "until", "!"))


def _backtick_code(text: str) -> str:
    """The text of every unquoted or double-quoted `...` command substitution of a command, joined into one text to be
    read as commands, or "" when there is none. An escaped backtick inside one is a nested substitution."""
    bodies: List[str] = []
    quote = ""
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if quote == "'":
            if ch == "'":
                quote = ""
        elif ch == "\\":
            i += 1
        elif ch == '"':
            quote = "" if quote == '"' else '"'
        elif ch == "'" and quote == "":
            quote = "'"
        elif ch == "`":
            body: List[str] = []
            j = i + 1
            while j < n and text[j] != "`":
                if text[j] == "\\" and j + 1 < n and text[j + 1] in ("`", "\\"):
                    j += 1
                body.append(text[j])
                j += 1
            bodies.append("".join(body))
            i = j
        i += 1
    return "\n".join(bodies)


def _cap_dir(p: str) -> Any:
    """A folder path as text through the same one-pass normalisation as cd, or _CWD_OVERFLOW when it is too long to follow."""
    norm = _norm_cwd(p)
    return _CWD_OVERFLOW if len(norm) > _MAX_CWD_CHARS else norm


def _join_dir(prev: Any, nxt: Optional[str]) -> Any:
    """The folder a chdir option sets (env -C, sudo -D), as written, joined to the one set before it by another wrapper:
    an anchored word wins, a relative one follows the earlier one."""
    if not nxt:
        return prev
    if prev is _CWD_OVERFLOW:
        return prev
    if prev is None or _ANCHORED_RE.match(nxt):
        return _cap_dir(nxt)
    return _cap_dir(prev + "/" + nxt)


def _in_dir(known: Any, d: Any) -> Any:
    """The folder a command runs in when it is wrapped in env -C / sudo -D: d is read from the folder known (None = unknown)."""
    if d is None:
        return known
    if d is _CWD_OVERFLOW:
        return _CWD_OVERFLOW
    if _ANCHORED_RE.match(d):
        return _cap_dir(d)
    return None if known is None else _cap_dir(known + "/" + d)


def _unwrap_dir(args: List[str]) -> Tuple[List[str], Optional[str]]:
    """The words of a command after wrappers that only run it (sudo, env, VAR=x, nohup, nice, time ...) and shell
    keywords, with the folder an env -C / --chdir or sudo -D / --chdir option moves to (None when there is none)."""
    i = 0
    guard = 0
    chdir: Optional[str] = None
    while guard < 32 and i < len(args):
        guard += 1
        # Assignments and keywords can repeat without limit (! ! ! rm -rf ~): they are skipped, not counted as wrappers.
        while i < len(args) and (_ASSIGN_RE.match(args[i]) or args[i] in _SHELL_KEYWORDS):
            i += 1
        if i >= len(args):
            break
        a = args[i]
        name = _program_name(a)
        if name in ("sudo", "doas"):
            i += 1
            while i < len(args) and args[i].startswith("-"):
                f = args[i]
                i += 1
                if f in ("-D", "--chdir"):
                    chdir = _join_dir(chdir, args[i] if i < len(args) else None)
                    i += 1
                    continue
                if re.match(r"^-D.", f):
                    chdir = _join_dir(chdir, f[2:])
                    continue
                if f.startswith("--chdir="):
                    chdir = _join_dir(chdir, f[8:])
                    continue
                if f in _SUDO_ARG_FLAGS:
                    i += 1
            continue
        if name == "env":
            i += 1
            while i < len(args) and (args[i].startswith("-") or _ASSIGN_RE.match(args[i])):
                f = args[i]
                i += 1
                if not f.startswith("-"):
                    continue
                if f == "--chdir" or re.match(r"^-[A-Za-z]*C\Z", f):
                    chdir = _join_dir(chdir, args[i] if i < len(args) else None)
                    i += 1
                    continue
                if f.startswith("--chdir="):
                    chdir = _join_dir(chdir, f[8:])
                    continue
                if re.match(r"^-C.", f):
                    chdir = _join_dir(chdir, f[2:])
                    continue
                if f in ("-u", "-S"):
                    i += 1
            continue
        # Every other wrapper of the shared list (nohup, nice, ionice, timeout, stdbuf, command, exec, xargs, busybox ...).
        if name in _WRAPPERS:
            i = _skip_wrapper(args, i, name)
            continue
        break
    return args[i:], chdir


def _unwrap(args: List[str]) -> List[str]:
    """The words of a command after wrappers and shell keywords."""
    return _unwrap_dir(args)[0]


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


def _interpreter_kind(head: str) -> str:
    """The interpreter family of a program name ('py', 'node', 'perl', 'ruby'), or ''."""
    if not _INTERPRETER_RE.match(head):
        return ""
    if head.startswith("py"):
        return "py"
    return "node" if head.startswith("node") else head


def _interpreter_code(kind: str, rest: List[str]) -> List[str]:
    """The code strings given on the command line of an interpreter (python -c CODE, node -e CODE, perl -e CODE, ruby -e CODE)."""
    spec = _INTERPRETERS[kind]
    out: List[str] = []
    i = 0
    while i < len(rest):
        w = rest[i]
        if w == "--" or not w.startswith("-"):
            break
        if spec.code.match(w):
            if i + 1 < len(rest):
                out.append(rest[i + 1])
            i += 2
            if kind in ("py", "node"):
                break
            continue
        m = _NODE_EVAL_EQ_RE.match(w) if kind == "node" else None
        if m:
            out.append(m.group(1))
            break
        if w in spec.skip:
            i += 1
        i += 1
    return out


def _protected_argument(tail: str) -> bool:
    """True when the first argument of a delete call names the home folder, the root or a system folder."""
    t = re.sub(r"^\s{0,20}", "", tail, count=1, flags=_A)
    wrap = _OI_PATH_WRAP_RE.match(t)
    if wrap:
        t = t[wrap.end():]
    home = _OI_HOME_RE.match(t)
    if home:
        return bool(_OI_AFTER_HOME_RE.match(t[home.end():]))
    lit = _OI_LITERAL_RE.match(t)
    if lit is None:
        return False
    return bool(_dangerous_path(_OI_ENV_HOME_RE.sub("~", lit.group(2))))


def _code_deletes_protected(code: str) -> bool:
    """True when interpreter code calls a recursive delete on the home folder, the root or a system folder."""
    for m in _OI_CALL_RE.finditer(code):
        name = m.group(1)
        if name in _OI_NEEDS_PAREN and not m.group(2):
            continue
        tail = code[m.end():m.end() + 300]
        if name in _OI_NEEDS_RECURSIVE and not _OI_RECURSIVE_RE.search(tail):
            continue
        if _protected_argument(tail):
            return True
    for m in _OI_GLOB_RE.finditer(code):
        if _protected_argument(code[m.end():m.end() + 300]):
            return True
    return False


def _reads_script_from_stdin(kind: str, rest: List[str]) -> bool:
    """True when an interpreter in a pipeline reads its program from the pipe: no script file, -c, -e or -m."""
    spec = _INTERPRETERS[kind]
    i = 0
    while i < len(rest):
        w = rest[i]
        if w == "-":
            return True
        if spec.no_stdin.match(w):
            return False
        if w.startswith("-"):
            if w in spec.skip:
                i += 1
            i += 1
            continue
        return False  # a script file: stdin is only data for it
    return True


_CD_HEADS = frozenset(("cd", "chdir", "pushd", "set-location", "sl", "push-location"))
_ANCHORED_RE = re.compile(r"^(?:[\\/~$%]|[A-Za-z]:)")
_NOT_CD = object()
# A folder path longer than this (after "." and ".." are resolved) is not followed: the line is refused instead.
_MAX_CWD_CHARS = 4096
_CWD_OVERFLOW = object()


def _norm_cwd(p: str) -> str:
    """One lexical pass over a folder path: backslashes become "/", repeated and trailing separators and "." segments go,
    and ".." is resolved where the path starts at a known point. A bare root ("/", "C:/") keeps its separator."""
    # On Windows a folder written with a trailing backslash before a space reaches this point as a trailing space.
    t = re.sub(r"(?:/\.)+(?=/|\Z)", "", re.sub(r"/{2,}", "/", p.rstrip().replace("\\", "/")))
    t = _resolve_dots(t)
    if len(t) > 1 and t.endswith("/") and not re.match(r"^[A-Za-z]:/\Z", t):
        t = t[:-1]
    return t or "/"


def _cd_target(args: List[str], cwd: Optional[str]) -> Any:
    """The working folder a cd or pushd leaves behind, as the path text to join relative words to: a string, or None
    when it cannot be known (cd -, a relative folder from an unknown place, popd). Returns _NOT_CD when the words are
    not a directory change."""
    if not args:
        return _NOT_CD
    head = _program_name(args[0])
    if head in ("popd", "pop-location"):
        return None
    if head not in _CD_HEADS:
        return _NOT_CD
    # cmd.exe's /d (change the drive too) is an option, not the folder.
    ops = [
        w for w in args[1:]
        if (not re.match(r"^-[A-Za-z]+\Z", w) or w == "-") and not (head in ("cd", "chdir") and w.lower() == "/d")
    ]
    if ops and ops[0] == "--":
        ops = ops[1:]
    # A bare cd goes home; a bare pushd swaps directories, which is not known here.
    if not ops:
        return None if head in ("pushd", "push-location") else "~"
    t = ops[0]
    if t == "-":
        return None
    # Anchored words (absolute, drive, home or variable) name the folder on their own; a relative word follows the old folder.
    to = t if _ANCHORED_RE.match(t) else (None if cwd is None else cwd + "/" + t)
    if to is None:
        return None
    norm = _norm_cwd(to)
    return _CWD_OVERFLOW if len(norm) > _MAX_CWD_CHARS else norm


def _from_cwd(cwd: Optional[str], word: str) -> str:
    """A word read from the folder cwd: relative words are joined to it, anchored words are kept."""
    if not cwd or not word or _ANCHORED_RE.match(word):
        return word
    return cwd.rstrip("/\\") + "/" + word


def _check_simple(words: List[str], depth: int, cwd: Optional[str] = None, known: Optional[str] = None) -> Optional[str]:
    args, chdir = _unwrap_dir(words)
    if known is None:
        known = cwd
    if chdir is not None:
        known = _in_dir(known, chdir)
        if known is _CWD_OVERFLOW:
            return _OVERFLOW
        cwd = known if known is not None and _dangerous_path(known) else None
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
    # The code is a download in a substitution (X="$(curl URL)"; sh -c "$X"): the same as sh -c "$(curl URL)".
    if (
        code is not None
        and (head in _SHELLS or head in ("su", "eval"))
        and re.match(r"^\s*(?:\$\(|`)", code)
        and _SHELL_RUNS_DOWNLOAD_RE.search('sh -c "' + code + '"')
    ):
        return "pipe_to_shell"
    if code is not None and depth < _MAX_DEPTH:
        hit = _analyze(code, depth + 1, known)
        if hit:
            return hit

    # Code an interpreter runs from its command line: python -c, node -e, perl -e, ruby -e.
    kind = _interpreter_kind(head)
    if kind and any(_code_deletes_protected(c) for c in _interpreter_code(kind, rest)):
        return "rm_root_home"

    if head in _RM_HEADS:
        if any(_recursive_flag(w, head) for w in rest) and any(_dangerous_path(_from_cwd(cwd, w)) for w in _operands(rest, head)):
            return "rm_root_home"
    if head == "find":
        paths: List[str] = []
        for w in rest:
            if w.startswith("-") or w == "(" or w == "!":
                break
            paths.append(w)
        # After a cd to a protected folder, a find with no path starts at ".".
        if cwd and not paths:
            paths.append(".")
        delete = "-delete" in rest or any(
            w == "-exec" and re.match(r"^(?:rm|shred)\Z", _program_name(rest[j + 1] if j + 1 < len(rest) else ""))
            for j, w in enumerate(rest)
        )
        filtered = any(_FIND_TESTS.match(w) for w in rest)
        if delete and not filtered and any(_dangerous_path(_from_cwd(cwd, w)) for w in paths):
            return "rm_root_home"
    if head in ("chmod", "chown", "chgrp"):
        if any(re.match(r"^-[A-Za-z]*R[A-Za-z]*\Z", w) or w == "--recursive" for w in rest):
            ops = _operands(rest, head)
            mode = ops[0] if ops else ""
            targets = [d for d in (_dangerous_path(_from_cwd(cwd, w)) for w in ops[1:]) if d]
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
            # an interpreter that reads its program from the pipe (python3, python3 -, node, perl, ruby)
            interp = "" if overflow or any(n in _SHELLS for n in names) else next((k for k in map(_interpreter_kind, names) if k), "")
            if interp:
                if _reads_script_from_stdin(interp, args[1:]):
                    return "pipe_to_shell"
                continue
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
    for words, _sep in pipe:
        for t in _redirect_targets(words):
            if _BLOCK_DEVICE_RE.match(t):
                return "disk_overwrite"
    return None


def _check_segments(
    segs: List[Tuple[List[str], Optional[str]]], depth: int, known0: Optional[str] = None
) -> Optional[str]:
    """known0 is the folder a cd or pushd earlier in the same command line (or the shell that runs this one) moved to, as
    text, or None when unknown. Relative targets are read from it only while it is a protected one (home, the root, a
    system folder). A cd inside a pipeline or a background command runs in a subshell and does not count."""
    pipe: List[Tuple[List[str], Optional[str]]] = []
    known = known0  # the folder as text, or None when unknown
    cwd = known if known is not None and _dangerous_path(known) else None  # the same, only while it is protected
    var_scope = _Vars()
    for words, sep in segs:
        # Literal variables assigned earlier on the line are filled in (X=curl; $X url | sh).
        words = var_scope.apply(words, sep)
        if var_scope.overflow:
            return _OVERFLOW
        hit = _check_simple(words, depth, cwd, known)
        if hit:
            return hit
        if sep not in ("|", "|&", "&"):
            to = _cd_target(_unwrap(words), known)
            if to is _CWD_OVERFLOW:
                return _OVERFLOW
            if to is not _NOT_CD:
                known = to
                cwd = known if known is not None and _dangerous_path(known) else None
        pipe.append((words, sep))
        if not _is_pipe(sep):
            hit2 = _check_pipeline(pipe)
            if hit2:
                return hit2
            pipe = []
    return _check_pipeline(pipe) if pipe else None


def _analyze(cmd: str, depth: int = 0, known: Optional[str] = None) -> Optional[str]:
    text = str(cmd)
    if len(text) > _MAX_CHARS:
        return _OVERFLOW
    bare = text if len(text) > _QUOTE_SCAN_MAX else _QUOTED_RE.sub("''", text)
    if _FORK_BOMB_RE.search(bare):
        return "fork_bomb"
    # PowerShell reading: a backtick and a line break continue the line, and so does a next line that starts with a pipe
    # (PowerShell 7), so `iwr URL` + newline + `| iex` is `iwr URL | iex`.
    if "`" in bare or "\n" in bare:
        ps_bare = _PS_NEXT_PIPE_RE.sub(" |", _PS_TICK_RE.sub("", _PS_LINE_TICK_RE.sub(" ", bare)))
    else:
        ps_bare = bare
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
    hit = _check_segments(segs, depth, known)
    if hit:
        return hit
    # A command substitution in backticks runs its text as commands (echo `rm -rf ~`); read them like a sh -c string.
    if depth < _MAX_DEPTH and "`" in text:
        inner = _backtick_code(text)
        inner_hit = _analyze(inner, depth + 1, known) if inner else None
        if inner_hit:
            return inner_hit
    # POSIX reading: an unquoted backslash escapes the next character and is removed (r\m, cu\rl, .bash\rc). The Windows
    # reading above keeps it as a path separator and runs first, so this one only adds blocks: any rule it hits counts.
    if "\\" in text:
        posix_hit = _check_segments(_segments_of(text, True)[0], depth, known)
        if posix_hit:
            return posix_hit
    # ANSI-C quoting: bash reads $'\x63url' as curl. The words are decoded the way bash does, then read again; as above,
    # this reading only adds a block, and only for the rules that name a program, a file or a path ($'\x73h',
    # $'.bash\x72c', $'\x72m' -rf $'\x7e').
    if "$'" in text:
        ansi_hit = _check_segments(_segments_of(_decode_ansi_c(text), True)[0], depth, known)
        if ansi_hit in ("pipe_to_shell", "rc_download", "rm_root_home"):
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
