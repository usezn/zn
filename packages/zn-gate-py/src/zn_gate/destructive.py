"""
Optional policy for destructive shell commands (Python twin of lib/destructive.js).

check_command() looks at one shell command (Bash, sh, zsh or PowerShell text) and
blocks only a few narrow shapes:

  rm_root_home     recursive delete of the home folder, the filesystem root, a
                   top-level system folder or a drive root
  pipe_to_shell    a download that is run as a script (or by python, node, perl or ruby) without being read
  disk_overwrite   dd, mkfs, wipefs ... on a block device, or a redirect to one
  perm_root        chmod -R 777 or chown -R on the root or a system folder
  fork_bomb        a shell function that starts itself twice per call in the background (the classic fork bomb)
  rc_download      a download written into a shell startup file

It is a guardrail against a model's mistake or a bad suggestion, not a sandbox: a
command built at run time (rm -rf "$DIR" with an empty variable, a script file the
agent wrote and then runs) is not seen. Calling check_command() is the opt-in: it
always applies the policy. Pure Python stdlib.

The Node.js and Python versions give the same answer on the shared test corpus
(packages/zn-gate/test/fixtures/destructive_commands.json).
"""

from __future__ import annotations

import itertools
import re
from typing import Any, Dict, FrozenSet, List, NamedTuple, Optional, Pattern, Tuple

from .rules import Assessment

COMMAND_RULES_VERSION = "2026-11-16.21"

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
_SUDO_ARG_FLAGS = {"-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "-U", "-D", "-R", "--user", "--group", "--host", "--prompt",
                   "--close-from", "--other-user", "--role", "--type", "--command-timeout", "--chroot"}
# More words than this that could each be the command behind an unsure wrapper chain: the line is refused, not guessed at.
_LATER_HEADS_MAX = 64

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
# A shell function definition, f() { ... } or function f { ... }, with a body that has no brace. Each body scan stops at
# the next brace, and a name starts only after a character that cannot be part of one, so the scan is linear.
_FUNC_DEF_RE = re.compile(
    r"(?<![\w:])(?:function\s+([A-Za-z_:][\w:]*)(?:\s*\(\s*\))?|([A-Za-z_:][\w:]*)\s*\(\s*\))\s*\{([^{}]*)\}", _A
)
# The words of a function body: line breaks, the control operators, ( and ), other words and blanks.
_BODY_TOKEN_RE = re.compile(r"\n|&&|\|\||[;&|()]|[^\s;&|()]+|[^\S\n]+", _A)
# Words after which the next word is still a command.
_BODY_LEAD_WORDS = {"do", "then", "else", "elif", "if", "while", "until", "!", "time"}
# The downloader inside the substitution may be written \curl, env curl, command -p curl or /usr/bin/curl, and the shell
# /bin/sh or env sh. Every quantifier below is over a class that cannot also match the separator after it, so the scan is linear.
# Up to three wrappers (sudo, doas, env, command, exec, nohup) with their option words may come before the downloader.
_SUBST_DL = (
    r"(?:(?:sudo|doas|env|command|exec|nohup)\s+(?:(?:-\S*|\w+=\S*)\s+)*){0,3}"
    r"\\?(?:[\w.~-]*/)*(?:c\\?u\\?r\\?l|w\\?g\\?e\\?t)\b"
)
_SUBST_SHELL = r"(?:[\w.~-]*/)*(?:ba|z|da|k)?sh"
# An interpreter that runs a program given as a file, on stdin or as its code option: python3 <(curl URL),
# python3 -c "$(curl URL)", node -e "$(curl URL)".
_SUBST_INTERP = r"(?:[\w.~-]*/)*(?:python(?:[23](?:\.\d+)?)?|py|pypy3?|node(?:js)?|perl|ruby)"
_SUBST_RUNNER = r"(?:" + _SUBST_SHELL + r"|" + _SUBST_INTERP + r")"
_SHELL_RUNS_DOWNLOAD_RE = re.compile(
    r"(?:^|[\s;&|(])(?:eval|" + _SUBST_SHELL + r"\s+(?:-\w+\s+)*-\w*c"
    r"|" + _SUBST_INTERP + r"\s+(?:-\w+\s+)*?(?:-\w*[ceE]|-p|--eval|--print))"
    r"\s+[\"']?(?:\$\(|`)\s*" + _SUBST_DL, _A
)
_SOURCE_DOWNLOAD_RE = re.compile(
    r"(?:^|[\s;&|(])(?:source|\.|" + _SUBST_RUNNER + r")\s+(?:-\w+\s+)*<\(\s*" + _SUBST_DL, _A
)
# A shell or interpreter that reads its program from a substitution on stdin: bash < <(curl URL), sh <<< "$(curl URL)".
_SHELL_STDIN_DOWNLOAD_RE = re.compile(
    r"(?:^|[\s;&|(])" + _SUBST_RUNNER + r"\s+(?:-\S*\s+)*(?:<\s*<\(|<<<\s*[\"']?(?:\$\(|`))\s*" + _SUBST_DL, _A
)
# After a pipe the next command may follow a line break or be a group: curl URL |<nl>sh, curl URL | (sh).
_PIPE_LEAD_RE = re.compile(r"(?:\s|\()+", _A)
# The executor may be called with the call or dot-source operator, and named in quotes: | & iex, | . 'iex', & "irm" URL.
_PS_EXEC = r"(?:[&.]\s*)?['\"]?(?:iex|invoke-expression)\b"
_PS_PIPE_RE = re.compile(
    r"\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^|;\n]{0,300}\|\s*" + _PS_EXEC
    + r"|\bdownloadstring\([^)]{0,300}\)\s*\|\s*" + _PS_EXEC,
    _AI,
)
_PS_CALL_RE = re.compile(
    r"(?:^|[\s;&|({])(?:iex|invoke-expression)\b[\s($]*(?:[&.]\s*)?['\"]?"
    r"(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|new-object\s+(?:system\.)?net\.webclient)\b",
    _AI,
)
# PowerShell escapes a character with a backtick (i`wr, Invoke-`Expression). Only a backtick inside a word counts: in
# POSIX shells a backtick starts a command substitution, so the text is never stripped for the other patterns.
_PS_QUOTED_NAME_RE = re.compile(
    r"([&.]\s*)(['\"])(iex|invoke-expression|iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\2", _AI
)
_PS_TICK_RE = re.compile(r"(?:(?<=[\s|;&(A-Za-z0-9_.-])|^)`(?=[A-Za-z-])", _A)
_PS_LINE_TICK_RE = re.compile(r"`\r?\n")
_PS_NEXT_PIPE_RE = re.compile(r"\r?\n[ \t]*\|")
_PS_DISK_RE = re.compile(r"(?:^|[\s;&|(])(?:format-volume|clear-disk)\b", _AI)

# Code an interpreter runs from its command line (python -c, node -e, perl -e, ruby -e) and a download piped into one.
# The option patterns are linear: an option word that may say "no program from stdin" has at most 32 letters on
# each side of its key letter. A longer word is not taken as such an option, so a pipe into it stays blocked.
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
        no_stdin=re.compile(r"^(?:-[A-Za-z]{0,32}[cmVh][A-Za-z]{0,32}|--(?:version|help))\Z", _A),
    ),
    "node": _InterpSpec(
        skip=frozenset({"-r", "--require", "--import", "--loader", "--experimental-loader"}),
        code=re.compile(r"^(?:-e|-p|-pe|--eval|--print)\Z", _A),
        no_stdin=re.compile(r"^(?:-[A-Za-z]{0,32}[epcvh][A-Za-z]{0,32}|--(?:eval|print|check|version|help|test)(?:=.*)?)\Z", _A | re.S),
    ),
    "perl": _InterpSpec(
        skip=frozenset({"-I"}),
        code=re.compile(r"^-[A-Za-z]*[eE]\Z", _A),
        no_stdin=re.compile(r"^-[A-Za-z]{0,32}[eEcvVh][A-Za-z]{0,32}\Z", _A),
    ),
    "ruby": _InterpSpec(
        skip=frozenset({"-r", "-I"}),
        code=re.compile(r"^-[A-Za-z]*e\Z", _A),
        no_stdin=re.compile(r"^(?:-[A-Za-z]{0,32}[ecvh][A-Za-z]{0,32}|--(?:version|help))\Z", _A),
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

# The drive of the system and of the home folder, as cmd.exe and PowerShell name them.
_DRIVE_VARS = r"%(?:systemdrive|homedrive)%|\$env:(?:systemdrive|homedrive)|\$\{env:(?:systemdrive|homedrive)\}"
_DRIVE_ROOT_WIN_RE = re.compile(r"(^|[\s\"'=:\\])([A-Za-z]:|" + _DRIVE_VARS + r")\\(?=[\s\"');&|}]|\Z)", _AI)
_DRIVE_VAR_RE = re.compile(r"^(?:" + _DRIVE_VARS + r")(?=/|\Z)", _AI)
_WINDIR_VAR_RE = re.compile(r"^(?:%(?:windir|systemroot)%|\$env:(?:windir|systemroot)|\$\{env:(?:windir|systemroot)\})(?=/|\Z)", _AI)
_DQ_ESCAPABLE = set('"\\$`\n')


_COMSPEC_WORDS = frozenset(("%comspec%", "$env:comspec", "${env:comspec}"))


def _program_name(text: str) -> str:
    # cmd.exe runs @rd like rd (the @ only hides the echo); PowerShell reads Rem`ove-Item as Remove-Item.
    name = re.sub(r"^[\\@]+", "", str(text))
    if "`" in name:
        name = re.sub(r"`(?=[A-Za-z-])", "", name)
    if name.lower() in _COMSPEC_WORDS:
        return "cmd"
    name = re.split(r"[\\/]", name)[-1].lower()
    return re.sub(r"\.exe\Z", "", name)


def _scan_first(s: str, posix: bool = False) -> Tuple[int, List[str], Optional[str]]:
    """The first simple command of s, like scanFirstCommand in lib/hooks/policy.js (backslash read as a Windows path separator)."""
    words: List[str] = []
    cur: Optional[List[str]] = None
    quote: Optional[str] = None
    i = 0
    n = len(s)
    raw_gt = -1  # index of the last unquoted, unescaped '>' that went into the word
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
        if ch == "#" and cur is None:
            # An unquoted word that starts with # opens a comment: the rest of the line is not part of the command.
            j = s.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "`" or (ch == "$" and i + 1 < n and s[i + 1] == "("):
            if cur is None:
                cur = []
            cur.append(ch)
            i += 1
            continue
        # `>|` is one redirection (it overrides noclobber), not a `>` followed by a pipe. Same rule as scanFirstCommand
        # in lib/hooks/policy.js: `>>|` is still split (bash rejects it, Node allows it).
        if ch == "|" and raw_gt == i - 1 and cur is not None and not "".join(cur).endswith(">>"):
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
        if ch == ">":
            raw_gt = i
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


class _Segs(List[Any]):
    """The simple commands of a line as (words, sep) pairs; raws holds the text of each one that has a backtick (else '')."""

    raws: List[str]
    opens: List[int]


def _segments_of(cmd: str, posix: bool = False) -> Tuple[List[Tuple[List[str], Optional[str]]], bool]:
    # Only the & changes, so the pattern starts at the last < or > before it: a long run of > stays linear.
    rest = re.sub(r"([<>])&(\d+|-)", r"\1_\2", str(cmd), flags=_A)
    rest = re.sub(r"&>>?", ">", rest)
    # A drive root C:\ before a space is a path, not an escaped space.
    if posix:
        rest = re.sub(r"(^|[\s\"'])([A-Za-z]:)\\(?=\s|\Z)", r"\1\2/", rest)
    else:
        # The Windows reading: cmd.exe and PowerShell have no backslash escapes, so C:\ (or %SystemDrive%\, the long
        # path form \\?\C:\, -Path:C:\, D=C:\) also ends before a quote, a ) ; & | or }. The POSIX reading keeps the
        # shell's own escapes, so text that only bash would read differently is still checked there.
        rest = _DRIVE_ROOT_WIN_RE.sub(r"\1\2/", rest)
    out = _Segs()
    out.raws = []
    out.opens = []
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
        raw = rest[:end]
        out.raws.append(raw if "`" in raw else "")
        out.opens.append(0)
        rest = rest[adv:]
        if sep in ("|", "|&"):
            lead = _PIPE_LEAD_RE.match(rest)
            if lead:
                # Each ( dropped here is still a group the line closes later: opens counts them so _check_segments pairs the ) with it.
                out.opens[-1] = lead.group(0).count("(")
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
_PS_ASSIGN_RE = re.compile(r"^\$\{?((?:env:)?[A-Za-z_][A-Za-z0-9_]*)\}?(=([\s\S]*))?\Z", _AI)
_PS_REF_RE = re.compile(r"\$(?:\{((?:env:)?[A-Za-z_][A-Za-z0-9_]*)\}|((?:env:)?[A-Za-z_][A-Za-z0-9_]*))", _AI)
_CMD_REF_RE = re.compile(r"%([A-Za-z_][A-Za-z0-9_]*)%|!([A-Za-z_][A-Za-z0-9_]*)!", _A)


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
    __slots__ = ("vars", "ps", "cmd", "assignments", "expanded", "overflow")

    def __init__(self) -> None:
        self.vars: Dict[str, str] = {}
        # PowerShell ($D = 'C:\', $env:D = ...) and cmd.exe (set D=C:\) variables; both ignore case.
        self.ps: Dict[str, str] = {}
        self.cmd: Dict[str, str] = {}
        self.assignments = 0
        self.expanded = 0
        self.overflow = False

    def _value(self, v: Optional[str], whole: str) -> str:
        if v is None:
            return whole
        self.expanded += len(v)
        return whole if self.expanded > _MAX_EXPANDED else v

    def substitute(self, word: str) -> str:
        if self.vars and "$" in word:
            word = _VAR_REF_RE.sub(lambda m: self._value(self.vars.get(m.group(1) or m.group(2)), m.group(0)), word)
        if self.ps and "$" in word:
            word = _PS_REF_RE.sub(lambda m: self._value(self.ps.get((m.group(1) or m.group(2)).lower()), m.group(0)), word)
        if self.cmd and ("%" in word or "!" in word):
            word = _CMD_REF_RE.sub(lambda m: self._value(self.cmd.get((m.group(1) or m.group(2)).lower()), m.group(0)), word)
        return word

    def _record(self, table: Dict[str, str], name: str, value: str) -> None:
        self.assignments += 1
        if self.assignments > _MAX_ASSIGNMENTS:
            self.overflow = True
        elif len(value) > _MAX_VALUE:
            table.pop(name, None)
        else:
            table[name] = value

    def _record_windows(self, out: List[str]) -> None:
        """A PowerShell assignment ($D = 'C:\\', $D='C:\\', $env:D = ...) or a cmd.exe set D=C:\\ line. Recorded even
        before a & (in cmd.exe it only separates commands), which can only add blocks."""
        if not out:
            return
        if out[0].startswith("$"):
            m = _PS_ASSIGN_RE.match(out[0])
            if not m:
                return
            if m.group(2) is None and len(out) == 3 and out[1] == "=":
                value: Optional[str] = out[2]
            elif m.group(2) is not None and m.group(3) and len(out) == 1:
                value = m.group(3)
            elif m.group(2) is not None and not m.group(3) and len(out) == 2:
                value = out[1]
            else:
                value = None
            if value is not None:
                self._record(self.ps, m.group(1).lower(), value)
        elif out[0].lower() == "set" and len(out) == 2:
            m = _VAR_ASSIGN_RE.match(out[1])
            if m:
                self._record(self.cmd, m.group(1).lower(), m.group(2))

    def apply(self, words: List[str], sep: Optional[str]) -> List[str]:
        """The words of one simple command with the known variables filled in, and any assignment it makes recorded.
        An assignment in a pipe or a background command runs in a subshell and is not recorded."""
        out = words
        if self.vars or self.ps or self.cmd:
            out = [self.substitute(w) for w in words]
            # A command word that is just a variable ($X url, | $S) is split on blanks, as an unquoted expansion is.
            if words:
                m = _VAR_SOLE_REF_RE.match(words[0])
                if m and (m.group(1) or m.group(2)) in self.vars:
                    out = out[0].split() + out[1:]
        if sep not in ("|", "|&"):
            self._record_windows(out)
            if self.overflow:
                return out
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
    "chrt": "TPD", "taskset": "c", "chroot": "ug", "runuser": "ugGsTw", "unbuffer": "", "strace": "eopsuEaOSbPIX",
    "ltrace": "eopsunal", "nsenter": "tSG", "flock": "wE",
}
# Wrappers that take positional arguments before the command: chrt <priority>, taskset <mask> (not with -c), chroot <newroot>, flock <lock>.
_WRAPPER_POSITIONAL = {"chrt": 1, "taskset": 1, "chroot": 1, "flock": 1}
# Long options of each wrapper that take the next word as their value, from its own manual (--opt=value is one word either way).
# Per wrapper, as in the Node policy: a long option not listed for the wrapper is a flag (so the chain is unsure and the later
# words are read as commands too). sudo --shell and --login, nsenter --pid and --user are flags.
_WRAPPER_LONG_VALUE = {
    "sudo": frozenset(("--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type", "--close-from", "--other-user", "--command-timeout", "--chroot",)),
    "env": frozenset(("--unset", "--chdir", "--split-string", "--argv0",)),
    "time": frozenset(("--format", "--output",)),
    "nice": frozenset(("--adjustment",)),
    "timeout": frozenset(("--signal", "--kill-after",)),
    "xargs": frozenset(("--max-args", "--max-procs", "--delimiter", "--arg-file", "--max-lines", "--max-chars", "--process-slot-var",)),
    "ionice": frozenset(("--class", "--classdata", "--pid", "--pgid", "--uid",)),
    "stdbuf": frozenset(("--input", "--output", "--error",)),
    "chrt": frozenset(("--sched-runtime", "--sched-period", "--sched-deadline",)),
    "chroot": frozenset(("--userspec", "--groups",)),
    "runuser": frozenset(("--user", "--group", "--supp-group", "--shell", "--command", "--whitelist-environment", "--session-command",)),
    "flock": frozenset(("--timeout", "--wait", "--conflict-exit-code", "--command",)),
    "nsenter": frozenset(("--target", "--setuid", "--setgid",)),
}
# A word taken as an option's value that names a program zn reads (rm, sh, find, curl ...) may really be the program, if the
# option was guessed wrong: the chain is then unsure, so that word and the later ones are read as commands too.
_SKIPPED_PROGRAM_RE = re.compile(r"^(?:rm|rmdir|del|erase|rd|ri|remove-item|shred|mkfs[a-z0-9.]*|mke2fs|mkswap|wipefs|blkdiscard|dd|find|chmod|chown|chgrp|sh|bash|zsh|dash|ksh|ash|mksh|rbash|su|eval|cmd|pwsh|powershell|python[0-9.]*|perl|ruby|node|curl|wget|iwr|irm|aria2c|fetch)\Z", re.ASCII | re.IGNORECASE)


def _skipped_is_program(t: str) -> bool:
    return bool(_SKIPPED_PROGRAM_RE.match(re.split(r"[\\/]", t.lstrip("("))[-1]))
# A word in command position that reads like an option value, not a program: a number or duration (10, +5, 1e3),
# a one-letter mode (stdbuf L), a user:group, a list or a format (%e).
_VALUE_LIKE_RE = re.compile(r"^[+-]?[0-9.]|^[A-Z]\Z|[:,%]")


def _skip_wrapper(words: List[str], k: int, name: str, info: Optional[Dict[str, bool]] = None) -> int:
    """The index of the word after a wrapper and its options (and the values some take), env's assignments and timeout's duration.
    With info, info["unsure"] is set when the chain may not end on the program: an option was read as a flag (it may take a
    value zn does not know of, or be an abbreviation such as --adj, which GNU tools accept), or the word reached reads like an
    option value. Callers then also read the later words as possible commands, so an unknown option cannot hide one."""
    value_opts = _WRAPPERS[name]
    saw_c = False
    unsure = False
    k += 1
    while k < len(words):
        t = words[k]
        if t == "--":
            k += 1
            break
        if t.startswith("--") and len(t) > 2:
            valued = "=" not in t and t in _WRAPPER_LONG_VALUE.get(name, ())
            if not valued and "=" not in t:
                unsure = True
            if valued and k + 1 < len(words) and _skipped_is_program(words[k + 1]):
                unsure = True
            k += 2 if valued else 1
            continue
        if t.startswith("-") and len(t) > 1:
            if t == "-c":
                saw_c = True
            valued = bool(re.match(r"^-[A-Za-z]+\Z", t)) and t[-1] in value_opts
            if not valued:
                unsure = True
            if valued and k + 1 < len(words) and _skipped_is_program(words[k + 1]):
                unsure = True
            k += 2 if valued else 1
            continue
        if name != "timeout" and _ASSIGN_RE.match(t):
            k += 1
            continue
        break
    # timeout's first operand is the duration, whatever its spelling (5, 1.5m, inf, 1e3, +5, 0x10): GNU reads it with strtod.
    if name == "timeout" and k < len(words):
        k += 1
    if name in _WRAPPER_POSITIONAL and k < len(words) and not (name == "taskset" and saw_c):
        k += _WRAPPER_POSITIONAL[name]
    if info is not None and (unsure or (k < len(words) and _VALUE_LIKE_RE.search(words[k]))):
        info["unsure"] = True
    return k


# Words that start a command without being one: a group, the branches of if / while / until / for, and negation.
_SHELL_KEYWORDS = frozenset(("{", "then", "do", "else", "elif", "if", "while", "until", "!"))
# Words of cmd.exe (call rd ...) and PowerShell (try { ... }) that only run the command after them.
_RUN_NEXT_WORDS = frozenset(("call", "try"))


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


def _in_dir(known: Any, dirs: List[str]) -> Any:
    """The folder a command runs in when it is wrapped in env -C / sudo -D: dirs are the words of its chdir options in
    order, each read from the folder before it (an anchored word wins, a relative one follows the earlier one); known is
    the folder before the command (None = unknown)."""
    for d in dirs:
        if known is _CWD_OVERFLOW:
            return known
        known = _folder_of(d) if _ANCHORED_RE.match(d) else _folder_rel(known, d)
    return known


def _add_dir(dirs: List[str], w: Optional[str]) -> None:
    if w:
        dirs.append(w)


# Programs that only run another command: more than 32 of them in a row is refused, not read.
_WRAPPER_CAP_NAMES = frozenset(("sudo", "doas", "env", "command", "exec", "nohup", "time", "builtin", "setsid", "nice", "ionice", "timeout"))


def _unwrap_dir(args: List[str]) -> Tuple[List[str], List[str], bool, List[str], bool, List[str], List[str]]:
    """The words of a command after wrappers that only run it (sudo, env, VAR=x, nohup, nice, time ...) and shell
    keywords, with the words of the env -C / --chdir and sudo -D / --chdir options and whether more wrappers than can be
    followed were met (the line is then refused), the strings of env -S / --split-string, and whether the chain may not
    end on the program (see _skip_wrapper: the caller then also reads the later words)."""
    i = 0
    guard = 0
    chdir: List[str] = []
    splits: List[str] = []
    # Where the words after the last -S value start: the string is read in place of the option, so what follows it
    # (options env had taken, such as the -rf of env -S "-S rm" -rf DIR) belongs to the command the string names.
    split_end = -1
    overflow = False
    chain = {"unsure": False}
    # Where the first wrapper starts: when the chain is unsure, the words it skipped as option values are read as commands too.
    first = -1
    while i < len(args):
        guard += 1
        # Assignments and keywords can repeat without limit (! ! ! rm -rf ~): they are skipped, not counted as wrappers.
        # So are the words that only introduce a command: function NAME { ...; } (the body is read like any other
        # commands, called or not) and coproc [NAME] { ...; } / coproc CMD (the command runs as a background job).
        while i < len(args):
            w = args[i]
            if _ASSIGN_RE.match(w) or w in _SHELL_KEYWORDS or w.lower() in _RUN_NEXT_WORDS:
                i += 1
            elif w == "function" and i + 1 < len(args):
                i += 2
            elif w == "coproc":
                i += 2 if i + 2 < len(args) and args[i + 2] in _SHELL_KEYWORDS else 1
            else:
                break
        if i >= len(args):
            break
        a = args[i]
        name = _program_name(a)
        # The guard is used up and the next word is still a wrapper: the rest cannot be read, so the line is refused.
        if guard > 32:
            overflow = name in _WRAPPER_CAP_NAMES or name in _WRAPPERS
            break
        if first < 0 and (name in ("sudo", "doas", "env", "start") or name in _WRAPPERS):
            first = i
        # cmd.exe's start [title] [/options] command: the options and an empty title are skipped. A title or an option
        # value may also be taken for the program, so the chain is unsure and the later words are read as well.
        if name == "start":
            i += 1
            while i < len(args) and (args[i] == "" or re.match(r"^/[A-Za-z]+\Z", args[i])):
                i += 2 if args[i].lower() in ("/d", "/affinity", "/node") else 1
            chain["unsure"] = True
            continue
        if name in ("sudo", "doas"):
            i += 1
            while i < len(args) and args[i].startswith("-"):
                f = args[i]
                i += 1
                if f in ("-D", "--chdir"):
                    _add_dir(chdir, args[i] if i < len(args) else None)
                    i += 1
                    continue
                if re.match(r"^-D.", f):
                    _add_dir(chdir, f[2:])
                    continue
                if f.startswith("--chdir="):
                    _add_dir(chdir, f[8:])
                    continue
                if f in _SUDO_ARG_FLAGS:
                    i += 1
                    continue
                # A flag zn does not know may take a value (a cluster such as -Eu root, a newer option).
                if not re.match(r"^--[^=]+=", f):
                    chain["unsure"] = True
            continue
        if name == "env":
            i += 1
            while i < len(args) and (args[i].startswith("-") or _ASSIGN_RE.match(args[i])):
                f = args[i]
                i += 1
                if not f.startswith("-"):
                    continue
                before = len(splits)
                i = _env_option(f, args, i, chdir, splits)
                if len(splits) > before:
                    split_end = i
            continue
        # Every other wrapper of the shared list (nohup, nice, ionice, timeout, stdbuf, command, exec, xargs, busybox ...).
        if name in _WRAPPERS:
            i = _skip_wrapper(args, i, name, chain)
            continue
        break
    return args[i:], chdir, overflow, splits, chain["unsure"], (args[first:] if first >= 0 else args), (args[split_end:] if split_end >= 0 else [])


_ENV_LONG = ("ignore-environment", "null", "unset", "chdir", "split-string", "argv0", "debug", "default-signal",
             "ignore-signal", "block-signal", "list-signal-handling", "version", "help")
_ENV_LONG_VALUE = ("unset", "chdir", "split-string", "argv0")


def _env_option(f: str, args: List[str], i: int, chdir: List[Any], splits: List[str]) -> int:
    """One env option word f (args[i - 1]); returns the index of the next word. Read like GNU env (getopt_long "+C:iS:u:v0a:"):
    a short cluster is walked letter by letter, and C, S, u or a take the rest of the cluster or the next word as their value;
    a long option may be an unambiguous prefix (--split-s, --chd). The -S string is kept for a second reading."""
    def take(kind: str, val: Any, has_val: bool) -> None:
        nonlocal i
        if not has_val:
            val = args[i] if i < len(args) else None
            i += 1
        if val is None:
            return
        if kind == "C":
            _add_dir(chdir, val)
        elif kind == "S":
            splits.append(val)

    if f.startswith("--"):
        eq = f.find("=")
        key = f[2:] if eq < 0 else f[2:eq]
        if not key:
            return i
        names = [n for n in _ENV_LONG if n.startswith(key)]
        name = key if key in names else (names[0] if len(names) == 1 else None)
        if name in _ENV_LONG_VALUE:
            take("C" if name == "chdir" else "S" if name == "split-string" else "u", None if eq < 0 else f[eq + 1:], eq >= 0)
        return i
    for k in range(1, len(f)):
        c = f[k]
        if c in "CSua":
            take(c, f[k + 1:], k + 1 < len(f))
            break
    return i


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
    # \\?\C:\ and \\.\C:\ are the long-path spellings of C:\; %SystemDrive% and $env:SystemDrive name the drive.
    t = re.sub(r"^/[?.]/(?=[A-Za-z]:)", "", t)
    t = _DRIVE_VAR_RE.sub("C:", t)
    t = _WINDIR_VAR_RE.sub("C:/Windows", t)
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


_CMD_OPTS_RE = re.compile(r"^(?:/[A-Za-z](?::[-A-Za-z]*)?)+\Z", _A)


def _recursive_flag(w: str, head: str) -> bool:
    # PowerShell: a backtick inside a parameter name is dropped (-Rec`urse), and -Recurse:$true is -Recurse.
    if "`" in w:
        w = w.replace("`", "")
    ps = re.match(r"^(-[A-Za-z]+):(\S*)\Z", w)
    if ps:
        if ps.group(2).lower() in ("$false", "false", "0", "$null"):
            return False
        w = ps.group(1)
    # cmd.exe options joined in one word (/s/q, /A:-h/S): one pass over the word, then a look for /s among them.
    if head in _CMD_HEADS and _CMD_OPTS_RE.match(w) and any(o.lower() == "s" for o in w.split("/")):
        return True
    if re.match(r"^-[fiIrRdvx]*[rR][fiIrRdvx]*\Z", w) or w == "--recursive":
        return True
    if re.match(r"^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\Z", w, re.I):
        return True
    return head in _CMD_HEADS and re.match(r"^/s\Z", w, re.I) is not None


def _is_cmd_flag(w: str, head: str) -> bool:
    # cmd.exe options may be joined (/s/q) and written in either case (/S /Q); del takes /A:attributes.
    return head in _CMD_HEADS and re.match(r"^(?:/[sqfa](?::?[-A-Za-z]*)?)+\Z", w, re.I) is not None


# PowerShell's -Path:C:\ and -LiteralPath:C:\ give the path in the same word as the parameter.
_PS_PATH_PARAM_RE = re.compile(r"^-(?:path|literalpath|lp|pspath):(.+)\Z", _AI | re.S)


def _operands(args: List[str], head: str) -> List[str]:
    out: List[str] = []
    rest = False
    for w in args:
        if not rest and w == "--":
            rest = True
            continue
        if not rest and (w.startswith("-") or _is_cmd_flag(w, head)):
            m = _PS_PATH_PARAM_RE.match(w) if head in _RM_HEADS else None
            if m:
                out.append(m.group(1))
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
    """Whether a chmod mode gives others write access: an octal mode (any number of leading zeros) whose last digit has
    the write bit, or a comma list of symbolic clauses (u=rwx,g=rwx,o=rwx, a+w, o=u) whose last say on the write bit of
    others sets it. A clause with no who (+w, =rwx) is taken to reach others too."""
    n = re.match(r"^0*([0-7]{1,4})\Z", mode)
    if n:
        return n.group(1)[-1] in "2367"
    others = False
    for clause in mode.split(","):
        m = re.match(r"^([ugoa]*)((?:[-+=](?:[ugo]|[rwxXst]*))+)\Z", clause)
        if not m:
            return False
        if m.group(1) != "" and not re.search(r"[ao]", m.group(1)):
            continue
        for op in re.finditer(r"([-+=])([ugo]|[rwxXst]*)", m.group(2)):
            # o=u and o+g copy the bits of the owner or the group, which have write access in the usual case.
            w = "w" in op.group(2) or op.group(2) in ("u", "g", "o")
            if op.group(1) == "=":
                others = w
            elif w:
                others = op.group(1) == "+"
    return others


def _spawns_itself(body: str, name: str) -> bool:
    """True when a function body runs `name` at least twice per call and at least once in the background (f|f&, f&f&,
    f|cat|f&): each call then starts two copies of itself that do not wait, which is a fork bomb. A recursive function
    that calls itself once, or only in the foreground, is not one."""
    calls = 0
    background = False
    at_command = True
    in_pipeline = False  # the current pipeline runs `name`
    for m in _BODY_TOKEN_RE.finditer(body):
        t = m.group(0)
        if t == "&":
            if in_pipeline:
                background = True
            in_pipeline = False
            at_command = True
        elif t in ("\n", ";", "&&", "||"):
            in_pipeline = False
            at_command = True
        elif t in ("|", "("):
            at_command = True
        elif t == ")" or t.isspace():
            pass  # a group closes or a blank: the state stays
        elif at_command:
            if t == name:
                calls += 1
                in_pipeline = True
            at_command = t in _BODY_LEAD_WORDS
    return calls >= 2 and background


def _fork_bomb(text: str) -> bool:
    """A fork bomb: a function that starts itself twice per call, at least once in the background, followed by a call to
    it after any command separator (:(){ :|:& };:, function f { f|f& }; f, f(){ f&f& };f, :(){ : | : & } && :)."""
    if "{" not in text:
        return False
    for m in _FUNC_DEF_RE.finditer(text):
        name = m.group(1) or m.group(2)
        if not _spawns_itself(m.group(3), name):
            continue
        i = m.end()
        while i < len(text) and text[i] in " \t\n\r\f\v;&|":
            i += 1
        nxt = text[i + len(name)] if i + len(name) < len(text) else ""
        if text.startswith(name, i) and not (nxt == ":" or nxt == "_" or (nxt.isascii() and nxt.isalnum())):
            return True
    return False


# A printf conversion (%s, %b, %-10s, %05d ...) or a literal %%. The width cannot start with 0, so the flags and the
# width never take the same characters and a long run of zeros is read once.
_PRINTF_CONV_RE = re.compile(r"%(?:%|[-+ #0]*(?:[1-9]\d*)?(?:\.\d*)?[sbqdiouxXcfeEgGaA])", _A)


def _printed_text(words: List[str]) -> Optional[str]:
    """The text echo or printf prints, read literally (no variable is evaluated): echo joins its words with blanks;
    printf fills each conversion of the format with the next argument and repeats the format while arguments are left.
    \\n and \\t print as a line break and a tab. None when the command is neither. Past _MAX_CHARS the text is cut, and
    the caller refuses it (_analyze returns _OVERFLOW for a longer text)."""
    name = _program_name(words[0]) if words else ""
    if name == "echo":
        i = 1
        while i < len(words) and re.match(r"^-[neE]+\Z", words[i]):
            i += 1
        out = " ".join(words[i:])
    elif name == "printf":
        i = 1
        if i < len(words) and words[i] == "--":
            i += 1
        if i >= len(words):
            return None
        fmt = words[i]
        args = words[i + 1:]
        k = 0
        parts: List[str] = []
        size = 0
        while True:
            used = False

            def fill(c: "re.Match[str]") -> str:
                nonlocal k, used
                if c.group(0) == "%%":
                    return "%"
                used = True
                if k < len(args):
                    k += 1
                    return args[k - 1]
                return ""

            piece = _PRINTF_CONV_RE.sub(fill, fmt)
            parts.append(piece)
            size += len(piece)
            if not used or k >= len(args) or size > _MAX_CHARS:
                break
        out = "".join(parts)
    else:
        return None
    return out.replace("\\n", "\n").replace("\\t", "\t")[: _MAX_CHARS + 1]


def _fed_text(word: str) -> str:
    """The program text a shell gets from one word given as its stdin or -c code: the text that echo or printf prints
    when the word is a command substitution of them ("$(echo 'rm -rf ~')", "`printf ...`", one or more echo/printf
    commands); otherwise the word itself."""
    m = re.match(r"^\s*(?:\$\(([\s\S]*)\)|`([\s\S]*)`)\s*\Z", word)
    if not m:
        return word
    inner = m.group(1) if m.group(1) is not None else m.group(2)
    segs, truncated = _segments_of(inner)
    if truncated or not segs:
        return word
    parts: List[str] = []
    for words, sep in segs:
        if not words:
            continue
        if sep is not None and sep not in (";", "\n", "&&"):
            return word
        t = _printed_text(words)
        if t is None:
            return word
        parts.append(t)
    return "\n".join(parts) if parts else word


def _shell_reads_stdin(rest: List[str]) -> bool:
    """Whether a shell command reads its program from stdin: no -c or -n option and no script file, or -s / - given."""
    if any(re.match(r"^-[A-Za-z]*[cn][A-Za-z]*\Z", w) for w in rest):
        return False
    files = [w for w in rest if not w.startswith("-")]
    return not files or "-s" in rest or "-" in rest


def _here_string_program(rest: List[str]) -> Optional[str]:
    """The text a here-string gives a shell (sh <<< 'rm -rf ~', bash <<<"$(echo ...)") when the shell reads its program
    from stdin, or None."""
    text: Optional[str] = None
    others: List[str] = []
    i = 0
    while i < len(rest):
        w = rest[i]
        m = re.match(r"^0?<<<([\s\S]*)\Z", w)
        if m:
            if m.group(1) != "":
                text = m.group(1)
            elif i + 1 < len(rest):
                i += 1
                text = rest[i]
            i += 1
            continue
        others.append(w)
        i += 1
    if text is None or not _shell_reads_stdin(_strip_redirects(others)):
        return None
    return _fed_text(text)


def _check_fed_pipe(pipe: List[Tuple[List[str], Optional[str]]], depth: int, known: Any) -> Optional[str]:
    """A pipeline whose shell reads its program from the output of echo or printf (echo 'rm -rf ~' | sh): the printed
    text is read as code, like a heredoc or a sh -c string."""
    if len(pipe) < 2 or depth >= _MAX_DEPTH:
        return None
    for j in range(1, len(pipe)):
        a, names, overflow, _d = _pipe_head(pipe[j][0])
        if overflow or not any(n in _SHELLS for n in names) or not _shell_reads_stdin(a[1:]):
            continue
        fa, _fn, f_overflow, _fd = _pipe_head(pipe[j - 1][0])
        text = None if f_overflow else _printed_text(fa)
        if text is None:
            continue
        hit = _analyze(text, depth + 1, known)
        if hit:
            return hit
    return None


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
# A folder that stepped above the home folder or a drive root is unknown, and treated as protected for the rest of the line.
_CWD_LOST = object()


class _Folder:
    """The folder a line has reached, kept as an immutable chain: an anchor (the root, a drive, a home word) and the
    segments below it, newest first. A cd adds or drops one segment, so the cost of a step does not depend on how long
    the folder is. kind is "root", "drive", "home" or "other" (a variable or ~user the line cannot see through)."""

    __slots__ = ("kind", "a", "up", "seg", "n", "len")

    def __init__(self, kind: str, a: str, up: Any = None, seg: str = "", n: int = 0, length: int = 0) -> None:
        self.kind = kind
        self.a = a
        self.up = up
        self.seg = seg
        self.n = n
        self.len = length or len(a)


def _folder_step(f: Any, seg: str) -> Any:
    """One step from folder f (a _Folder, _CWD_LOST or None): a segment name, "." or "..". Returns the new folder,
    _CWD_LOST, None (unknown) or _CWD_OVERFLOW."""
    if f is None or f is _CWD_LOST or f is _CWD_OVERFLOW:
        return f
    if seg in ("", "."):
        return f
    if seg == "..":
        if f.n > 0:
            return f.up
        if f.kind == "home":
            return _CWD_LOST
        return None if f.kind == "other" else f
    length = f.len + len(seg) + 1
    if length > _MAX_CWD_CHARS:
        return _CWD_OVERFLOW
    return _Folder(f.kind, f.a, f, seg, f.n + 1, length)


def _folder_walk(f: Any, path: str) -> Any:
    for seg in path.split("/"):
        f = _folder_step(f, seg)
        if f is None or f is _CWD_LOST or f is _CWD_OVERFLOW:
            return f
    return f


def _folder_of(word: str) -> Any:
    """The folder an anchored word names (absolute, drive, home or variable)."""
    t = re.sub(r"/{2,}", "/", str(word).rstrip().replace("\\", "/"))
    drive = re.match(r"^[A-Za-z]:(?:/|\Z)", t)
    if t.startswith("/"):
        return _folder_walk(_Folder("root", "/"), t[1:])
    if drive:
        return _folder_walk(_Folder("drive", t[:2] + "/"), t[drive.end():])
    first = t.split("/")[0]
    kind = "home" if first.lower() in _HOME_WORDS else "other"
    return _folder_walk(_Folder(kind, first + "/"), t[len(first) + 1:])


def _folder_text(f: Any, m: int) -> str:
    """The text of the last m segments of folder f, as a path; when segments are left out it starts at a made-up anchor."""
    segs = []
    g = f
    i = 0
    while i < m and g.n > 0:
        segs.append(g.seg)
        g = g.up
        i += 1
    segs.reverse()
    base = "/__" if g.n > 0 else ("" if g.kind == "root" else g.a.rstrip("/"))
    return base + ("/" + "/".join(segs) if segs else "")


def _cd_target(args: List[str], cwd: Any) -> Any:
    """The working folder a cd or pushd leaves behind: a _Folder, _CWD_LOST, or None when it cannot be known (cd -, a
    relative folder from an unknown place, popd). cwd is the folder before the command (None = unknown). Returns
    _NOT_CD when the words are not a directory change."""
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
        return None if head in ("pushd", "push-location") else _folder_of("~")
    t = ops[0]
    if t == "-":
        return None
    # Anchored words (absolute, drive, home or variable) name the folder on their own; a relative word follows the old folder.
    if _ANCHORED_RE.match(t):
        return _folder_of(t)
    return _folder_rel(cwd, t)


def _folder_rel(cwd: Any, w: str) -> Any:
    """A relative folder word followed from the folder cwd (None = unknown)."""
    if cwd is None:
        return None
    return _folder_walk(cwd, w.rstrip().replace("\\", "/"))


def _from_cwd(cwd: Any, word: str) -> str:
    """A word read from the folder cwd: relative words are joined to it, anchored words are kept. Only as many trailing
    segments of the folder as the word's ".." can reach (plus four) are written out: a protected folder is at most three
    segments deep, so the rest cannot change the answer."""
    if not cwd or not word or _ANCHORED_RE.match(word):
        return word
    if cwd is _CWD_LOST:
        return "/"
    ups = sum(1 for s in re.split(r"[\\/]", word) if s == "..")
    return _folder_text(cwd, ups + 4) + "/" + word


def _check_simple(words: List[str], depth: int, known: Any = None) -> Optional[str]:
    args, chdir, overflow, splits, unsure, chain_words, split_tail = _unwrap_dir(words)
    if overflow:
        return _OVERFLOW
    if chdir:
        known = _in_dir(known, chdir)
        if known is _CWD_OVERFLOW:
            return _OVERFLOW
    # env -S "rm -rf ~": the split strings (env joins their words in order) are a command line of its own, followed by
    # the words after them. One reading for all of them, so the cost does not multiply with the number of -S options.
    # Strings inside strings (env -S "env -S 'rm -rf /home/alice'", env -S "-S rm -rf /home/alice") are read again the same
    # way, up to _MAX_DEPTH levels; a deeper one is refused, not skipped.
    if splits and depth >= _MAX_DEPTH:
        return _OVERFLOW
    if splits:
        tail = " ".join("'" + w.replace("'", "'\\''") + "'" for w in split_tail)
        # The string is read as the rest of an env command, so env options inside it (-i, -u NAME, -C DIR, -S) are read too.
        text = " ".join(re.sub(r"\\[_tnvfr]", " ", x) for x in splits)
        hit = _analyze("env " + text + " " + tail, depth + 1, known)
        if hit:
            return hit
    if not args:
        return None
    hit = _check_head(args, depth, known)
    if hit or not unsure:
        return hit
    # From the first wrapper on, so a word skipped as an option's value is read as a possible command as well.
    return _check_later_heads(chain_words, depth, known)


def _head_is_read(name: str) -> bool:
    """Whether the rules of _check_head read a command with this program name as its head."""
    return (name in _RM_HEADS or bool(_DISK_TOOLS.match(name)) or name in _SHELLS or name in _POWERSHELLS
            or name in ("su", "eval", "iex", "invoke-expression", "cmd", "find", "chmod", "chown", "chgrp", "dd")
            or bool(_interpreter_kind(name)))


def _check_later_heads(args: List[str], depth: int, known: Any) -> Optional[str]:
    """A wrapper chain that may not end on the program (an option zn does not know may have taken the next word as its
    value): each later word that names a program these rules read is checked as the head too, so the option cannot hide
    the command."""
    n = 0
    for j in range(1, len(args)):
        if not _head_is_read(_program_name(args[j])):
            continue
        n += 1
        if n > _LATER_HEADS_MAX:
            return _OVERFLOW
        hit = _check_head(args[j:], depth, known)
        if hit:
            return hit
    return None


_PS_VALUE_OPTS = frozenset((
    "-executionpolicy", "-ep", "-ex", "-windowstyle", "-w", "-win", "-inputformat", "-if", "-outputformat", "-of", "-o",
    "-configurationname", "-workingdirectory", "-wd", "-settingsfile", "-version", "-v", "-psconsolefile",
    "-custompipename", "-encodedarguments", "-ea",
))


def _ps_positional_code(rest: List[str]) -> Optional[str]:
    """powershell Remove-Item ...: Windows PowerShell runs the words after its options as a command when no -Command,
    -File or -EncodedCommand is given. A first word that names a .ps1 file is a script, not code."""
    j = 0
    while j < len(rest) and rest[j].startswith("-"):
        opt = rest[j].lower()
        if opt in ("-file", "-f", "-encodedcommand", "-enc", "-ec", "-e"):
            return None
        j += 2 if opt in _PS_VALUE_OPTS else 1
    if j >= len(rest) or rest[j].lower().endswith(".ps1"):
        return None
    return " ".join(rest[j:])


def _check_head(args: List[str], depth: int, known: Any) -> Optional[str]:
    """The rules for one simple command whose head is args[0]."""
    head = _program_name(args[0])
    rest = args[1:]

    code: Optional[str] = None
    if head in _SHELLS or head == "su":
        k = next((j for j, w in enumerate(rest) if re.match(r"^-[A-Za-z]*c[A-Za-z]*\Z", w)), -1)
        if k >= 0 and k + 1 < len(rest):
            code = rest[k + 1]
    elif head in ("eval", "iex", "invoke-expression"):
        code = " ".join(rest)
    elif head in _POWERSHELLS:
        k = next((j for j, w in enumerate(rest) if re.match(r"^-c(?:ommand)?\Z", w, re.I)), -1)
        if k >= 0:
            code = " ".join(rest[k + 1:])
        else:
            code = _ps_positional_code(rest)
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
    # The text echo or printf prints into the shell: sh -c "$(echo 'rm -rf ~')", eval "$(printf ...)", sh <<< 'rm -rf ~'.
    if (head in _SHELLS or head in ("su", "eval")) and depth < _MAX_DEPTH:
        if code is not None:
            fed: Optional[str] = _fed_text(code)
        else:
            fed = _here_string_program(rest) if head in _SHELLS else None
        if fed is not None and fed != code:
            hit = _analyze(fed, depth + 1, known)
            if hit:
                return hit

    # Code an interpreter runs from its command line: python -c, node -e, perl -e, ruby -e.
    kind = _interpreter_kind(head)
    if kind and any(_code_deletes_protected(c) for c in _interpreter_code(kind, rest)):
        return "rm_root_home"

    if head in _RM_HEADS:
        if any(_recursive_flag(w, head) for w in rest) and any(_dangerous_path(_from_cwd(known, w)) for w in _operands(rest, head)):
            return "rm_root_home"
    if head == "find":
        paths: List[str] = []
        # GNU find takes -P, -L, -H, -O<level> and -D <options> before the starting paths; they do not end the list of paths.
        first = 0
        while first < len(rest):
            if re.match(r"^-(?:[PLH]|O\d*)\Z", rest[first]):
                first += 1
            elif rest[first] == "-D":
                first += 2
            else:
                break
        for w in rest[first:]:
            if w.startswith("-") or w == "(" or w == "!":
                break
            paths.append(w)
        # After a cd to a protected folder, a find with no path starts at ".".
        if known and not paths:
            paths.append(".")
        # -execdir, -ok and -okdir run the program like -exec does (in the folder of each file, or after a prompt).
        delete = "-delete" in rest or any(
            re.match(r"^-(?:exec|execdir|ok|okdir)\Z", w)
            and re.match(r"^(?:rm|shred)\Z", _program_name(rest[j + 1] if j + 1 < len(rest) else ""))
            for j, w in enumerate(rest)
        )
        # From the filesystem root even a filtered delete is refused: a test does not make that safe.
        filtered = any(_FIND_TESTS.match(w) for w in rest)
        from_root = any(_dangerous_path(_from_cwd(known, w)) == "root" for w in paths)
        if delete and (not filtered or from_root) and any(_dangerous_path(_from_cwd(known, w)) for w in paths):
            return "rm_root_home"
        # -files0-from FILE (or - for stdin) loads the starting paths from a file the command text does not show, so a delete
        # over them cannot be checked: refuse it (fail closed). It is never read. Non-deleting uses (-print) stay allowed.
        if delete and "-files0-from" in rest:
            return "rm_root_home"
    if head in ("chmod", "chown", "chgrp"):
        if any(re.match(r"^-[A-Za-z]*R[A-Za-z]*\Z", w) or w == "--recursive" for w in rest):
            ops = _operands(rest, head)
            mode = ops[0] if ops else ""
            targets = [d for d in (_dangerous_path(_from_cwd(known, w)) for w in ops[1:]) if d]
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
    seen = 0  # every alternative counts towards the limit, repeated ones too
    for alt in m.group(1).split(","):
        rest = _expand_braces(s[:m.start()] + alt + s[m.end():], limit, depth + 1)
        if rest is None:
            return None
        for x in rest:
            seen += 1
            if seen > limit:
                return None
            if x not in out:  # the outer list repeats its other alternatives for each inner one
                out.append(x)
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


def _strip_redirects(words: List[str]) -> List[str]:
    """The words of a command without its redirections and their targets (>> ~/.bashrc curl URL is curl URL)."""
    out: List[str] = []
    skip = False
    for w in words:
        if skip:
            skip = False
            continue
        if re.match(r"^\d*[<>]>?\|?\Z", w, _A):
            skip = True
            continue
        if re.match(r"^\d*[<>]>?\|?[^<>(\s]", w, _A):
            continue
        out.append(w)
    return out


def _segment_dir(known: Any, d: Optional[List[str]]) -> Any:
    """The folder a segment of a pipeline runs in: known (None = unknown) moved by an env -C / sudo -D in front of it."""
    return _in_dir(known, d) if d else known


def _pipe_args(a: List[str], unsure: bool) -> List[str]:
    """The words of a pipeline segment from its program on. When the wrapper chain may not end on the program (unsure) and
    its head is not a downloader, shell or interpreter, the first later word that is one starts it (curl URL | nice --adj 5 sh)."""
    if not unsure or len(a) < 2:
        return a

    def is_prog(w: str) -> bool:
        n = _program_name(w)
        return n in _DOWNLOADERS or n in _SHELLS or bool(_interpreter_kind(n))

    if is_prog(a[0]):
        return a
    j = next((i for i in range(1, len(a)) if is_prog(a[i])), -1)
    return a[j:] if j > 0 else a


def _split_glued_redirects(words: List[str]) -> List[str]:
    """A redirect written against the word before it (curl URL>> ~/.bashrc, curl URL>~/.bashrc) is a word of its own:
    the shell ends a word at >. A word of digits only before > is a file descriptor (2>), so it stays as it is."""
    if not any(">" in w for w in words):
        return words
    out: List[str] = []
    for w in words:
        i = w.find(">")
        if i > 0 and not w[:i].isdigit() and w[0] not in "<>":
            out.append(w[:i])
            out.append(w[i:])
        else:
            out.append(w)
    return out


def _pipe_head(words: List[str]) -> Tuple[List[str], List[str], bool, List[str]]:
    """The words of a pipeline command from its program on, the program names it may be (brace lists), whether there
    are too many of them, and its env -C / sudo -D folders. env -S 'curl URL' and eval curl URL run the words they are given."""
    a, d, _ovf, spl, unsure, _all, _tail = _unwrap_dir(_strip_redirects(words))
    if spl:
        a = " ".join(spl).split() + a
    if a and _program_name(a[0]) == "eval":
        a = " ".join(a[1:]).split()
    a = _pipe_args(a, unsure)
    alts = _brace_alts(a[0]) if a else [""]
    names = [_program_name(x) for x in (alts if alts is not None else [str(a[0])])]
    return a, names, alts is None, d


def _runs_download(words: List[str]) -> bool:
    _a, names, overflow, _d = _pipe_head(words)
    return overflow or any(n in _DOWNLOADERS for n in names)


def _check_pipeline(
    pipe: List[Tuple[List[str], Optional[str]]], known: Optional[str] = None, fds: Optional[Dict[str, str]] = None
) -> Optional[str]:
    """fds holds the files that exec opened earlier on the line (exec 3>> ~/.bashrc), by descriptor."""
    pipe = [(_split_glued_redirects(w), s) for w, s in pipe]
    heads = []
    for words, _sep in pipe:
        a, names, overflow, d = _pipe_head(words)
        heads.append((a, names[0], names, overflow, _segment_dir(known, d)))
    if any(h[4] is _CWD_OVERFLOW for h in heads):
        return _OVERFLOW
    first_dl = next((j for j, h in enumerate(heads) if h[3] or any(n in _DOWNLOADERS for n in h[2])), -1)
    if first_dl >= 0:
        for j in range(first_dl + 1, len(pipe)):
            args, head, names, overflow, _dir = heads[j]
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
                dup = re.match(r"^\d*>>?_(\d+)\Z", w, _A)
                if re.match(r"^\d*>>?\|?\Z", prev, _A):
                    target = w
                elif dup:
                    # >&3 writes to the file descriptor 3 that an earlier exec 3>> FILE opened.
                    target = (fds or {}).get(dup.group(1))
                elif re.match(r"^\d*>>?\|?.+\Z", w, _A | re.S):
                    target = re.sub(r"^\d*>>?\|?", "", w, count=1, flags=_A)
                elif _out_flag(prev):
                    target = w
                elif re.match(r"^(?:--output|--output-document|-OutFile)[=:]", w, re.I):
                    target = re.sub(r"^[^=:]*[=:]", "", w, count=1)
                elif re.match(r"^-[A-Za-z]*?[oO]\S", w):
                    target = re.sub(r"^-[A-Za-z]*?[oO]", "", w, count=1)  # curl -o$HOME/.bashrc
                elif heads[j][1] == "tee" and not w.startswith("-") and i > 0:
                    target = w
                elif heads[j][1] == "dd" and w.startswith("of="):
                    target = w[3:]
                if target is not None:
                    # A relative file is read from the folder an earlier cd, pushd or env -C moved to.
                    alts = _brace_alts(_from_cwd(heads[j][4], target))
                    if alts is None or any(_is_rc_path(t) for t in alts):
                        return "rc_download"
    for words, _sep in pipe:
        for t in _redirect_targets(words):
            if _BLOCK_DEVICE_RE.match(t):
                return "disk_overwrite"
    return None


# ${NAME:-word}, ${NAME-word}, ${NAME:=word}, ${NAME=word}, ${NAME:+word}, ${NAME+word} and ${NAME:?word} with no
# brace inside (an inner one is read first, so nested defaults are followed from the inside out).
_DEFAULT_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-=+?])([^{}]*)\}", _A)
# Readings of one simple command (one per choice of default values); past it every alternative is still read once.
_MAX_VARIANTS = 64
# Words one brace expansion may give (rm -rf build{1..99} is 99); past it the word is too many to follow.
_BRACE_WORDS_MAX = 1024
# Words a simple command may have after brace expansion.
_EXPANDED_WORDS_MAX = 4096


def _default_alts(word: str, scope: "_Vars") -> Optional[List[str]]:
    """The words a word with default-value expansions may become: the variable's value when the line assigned it, else
    both the variable (unknown) and the default word; None when there are more than _MAX_VARIANTS."""
    if "${" not in word or not _DEFAULT_RE.search(word):
        return [word]
    out: List[str] = []
    work = [word]
    steps = 0
    while work:
        w = work.pop()
        m = _DEFAULT_RE.search(w)
        if not m:
            if w not in out:
                out.append(w)
            if len(out) > _MAX_VARIANTS:
                return None
            continue
        steps += 1
        if steps > _MAX_VARIANTS * 8:
            return None
        name, op, dflt = m.group(1), m.group(2), m.group(3)
        known = scope.vars.get(name)
        colon = op.startswith(":")
        if op.endswith("+"):
            choices = ["", dflt] if known is None else ([dflt] if (known or not colon) else [""])
        elif op.endswith("?"):
            choices = ["$" + name] if known is None else [known]
        elif known is None:
            choices = ["$" + name, dflt]
        else:
            choices = [dflt] if (colon and not known) else [known]
        for c in reversed(choices):
            work.append(w[:m.start()] + c + w[m.end():])
    return out


def _brace_words(w: str) -> Optional[List[str]]:
    """The words a word with brace lists becomes ({rm,-rf,/} is rm -rf /), or None when there are too many."""
    if "{" not in w or ("," not in w and ".." not in w):
        return [w]
    return _expand_braces(_SEQ_RE.sub(_expand_seq, w), _BRACE_WORDS_MAX)


def _word_readings(words: List[str], scope: "_Vars") -> Optional[List[List[str]]]:
    """The readings of one simple command after default-value and brace expansion: the first is the plain reading with
    braces expanded; there is one more for each choice of default values (or, past _MAX_VARIANTS, enough for each
    alternative of each word to be read once). None when a word expands to more words than can be followed and the
    command is one these rules read: the caller refuses the line."""
    if not any("{" in w for w in words):
        return [words]
    per_word: List[List[List[str]]] = []
    total = 1
    too_many = False
    prefix = True  # still in the assignment words before the command
    for w in words:
        alts = _default_alts(w, scope) if "${" in w else [w]
        if alts is None:
            too_many = True
            alts = [w]
        group: List[List[str]] = []
        assign = prefix and bool(_ASSIGN_RE.match(w))
        prefix = assign
        for a in alts:
            # An assignment word before the command (X={a,b} cmd) is not brace-expanded by the shell.
            if assign:
                group.append([a])
                continue
            bw = _brace_words(a)
            if bw is None:
                too_many = True
                bw = [a]
            group.append(bw)
        per_word.append(group)
        total *= len(group)
        if total > _MAX_VARIANTS:
            total = _MAX_VARIANTS + 1
    if too_many and any(_head_is_read(_program_name(w)) for w in words):
        return None
    if total <= _MAX_VARIANTS:
        combos: List[List[List[str]]] = [list(c) for c in itertools.product(*per_word)]
    else:
        width = max(len(g) for g in per_word)
        combos = [[g[min(k, len(g) - 1)] for g in per_word] for k in range(width)]
    # The words as written come first: the pipeline rules read a brace list in a program name as alternatives
    # (curl URL | s{h,} counts as a pipe into sh), which a split into words would lose.
    out: List[List[str]] = [words]
    for combo in combos:
        flat = [x for part in combo for x in part]
        if len(flat) > _EXPANDED_WORDS_MAX:
            if any(_head_is_read(_program_name(w)) for w in words):
                return None
            flat = words
        if flat not in out:
            out.append(flat)
    return out


# Most backtick substitutions read from a changed folder in one command line; past it the line is refused.
_MAX_TICK_READS = 200


def _check_segments(
    segs: List[Tuple[List[str], Optional[str]]], depth: int, cwd0: Any = None
) -> Optional[str]:
    """cwd0 is the folder a cd or pushd earlier in the same command line moved to (None = unknown). A cd inside a pipeline or a background command runs in a subshell and does not count."""
    pipe: List[Tuple[List[str], Optional[str]]] = []
    # The readings of each command of the pipeline (default values and brace lists), see _word_readings.
    pipe_readings: List[List[List[str]]] = []
    known = cwd0  # the folder reached so far: a _Folder, _CWD_LOST, or None when unknown
    # A ( group runs in a subshell: a cd inside it does not move the folder of what follows the ). Each "(" saves the folder.
    groups: List[Any] = []
    raws = getattr(segs, "raws", None)
    opens = getattr(segs, "opens", None)
    ticks = 0
    var_scope = _Vars()
    # One entry per open { } or ( ) group: whether a download ran inside it. The output of the group is the output of
    # that download, so the command that closes it ({ curl URL; } | sh, (curl URL) >> ~/.bashrc) is read as a download.
    dl_groups: List[bool] = []
    closed_dl = False  # the last ) closed a group with a download in it
    fds: Dict[str, str] = {}  # files exec opened by descriptor (exec 3>> ~/.bashrc)
    for idx, (words, sep) in enumerate(segs):
        # Literal variables assigned earlier on the line are filled in (X=curl; $X url | sh).
        words = var_scope.apply(words, sep)
        if var_scope.overflow:
            return _OVERFLOW
        if sep == "(" and len(groups) < _MAX_SEGMENTS:
            groups.append(known)
        readings = _word_readings(words, var_scope)
        if readings is None:
            return _OVERFLOW
        for reading in readings:
            hit = _check_simple(reading, depth, known)
            if hit:
                return hit
        # The group bookkeeping for downloads.
        group_dl = closed_dl
        closed_dl = False
        if words and words[0] == "{" and len(dl_groups) < _MAX_SEGMENTS:
            dl_groups.append(False)
        if words and words[0] == "}" and dl_groups:
            group_dl = _close_group(dl_groups) or group_dl
        if dl_groups and not dl_groups[-1] and _runs_download(readings[0]):
            dl_groups[-1] = True
        if words and words[0] == "exec":
            _record_fds(words, fds)
        if group_dl:
            # The command that receives the output of the group: read with a downloader in front of it.
            rest = words[1:] if words and words[0] == "}" else words
            words = ["curl"] + rest
            readings = [["curl"] + (r[1:] if r and r[0] == "}" else r) for r in readings]
        # A command substitution in backticks starts in the folder the line has reached, like $( ) and sh -c. While the folder
        # is still the one the line started in, the whole-line reading in _analyze() has already covered it.
        if raws and raws[idx] and known is not cwd0 and depth < _MAX_DEPTH:
            ticks += 1
            if ticks > _MAX_TICK_READS:
                return _OVERFLOW
            inner = _backtick_code(raws[idx])
            inner_hit = _analyze(inner, depth + 1, known) if inner else None
            if inner_hit:
                return inner_hit
        if sep not in ("|", "|&", "&"):
            to = _cd_target(_unwrap(words), known)
            if to is _CWD_OVERFLOW:
                return _OVERFLOW
            if to is not _NOT_CD:
                known = to
        pipe.append((words, sep))
        pipe_readings.append(readings)
        if not _is_pipe(sep):
            fed_hit = _check_fed_pipe(pipe, depth, known)
            if fed_hit:
                return fed_hit
            hit2 = _check_pipeline_readings(pipe, pipe_readings, known, fds)
            if hit2:
                return hit2
            pipe = []
            pipe_readings = []
        # A ( dropped after a pipe (curl URL | (sh)) opens a group of its own: save the folder so its ) pops that entry, not the enclosing one.
        if opens:
            for _ in range(opens[idx]):
                if len(groups) < _MAX_SEGMENTS:
                    groups.append(known)
                if len(dl_groups) < _MAX_SEGMENTS:
                    dl_groups.append(False)
        if sep == "(" and len(dl_groups) < _MAX_SEGMENTS:
            dl_groups.append(False)
        if sep == ")":
            if groups:
                known = groups.pop()
            if dl_groups:
                closed_dl = _close_group(dl_groups)
    if not pipe:
        return None
    return _check_fed_pipe(pipe, depth, known) or _check_pipeline_readings(pipe, pipe_readings, known, fds)


def _close_group(dl_groups: List[bool]) -> bool:
    """Close the innermost group; a download inside it is also inside the group around it."""
    had = dl_groups.pop()
    if had and dl_groups:
        dl_groups[-1] = True
    return had


def _record_fds(words: List[str], fds: Dict[str, str]) -> None:
    """The files an exec line opens for writing: exec 3>> FILE, exec 3>FILE."""
    for i, w in enumerate(words):
        m = re.match(r"^(\d+)>>?\|?(.*)\Z", w, _A | re.S)
        if not m:
            continue
        target = m.group(2) or (words[i + 1] if i + 1 < len(words) else "")
        if target and len(fds) < _MAX_ASSIGNMENTS:
            fds[m.group(1)] = target


def _check_pipeline_readings(
    pipe: List[Tuple[List[str], Optional[str]]], readings: List[List[List[str]]], known: Any,
    fds: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    """The pipeline rules for each reading k: every command takes its own reading k (or its last one)."""
    width = max(len(r) for r in readings)
    n = len(pipe)
    if width == 1 and all(readings[i][0] is pipe[i][0] for i in range(n)):
        return _check_pipeline(pipe, known, fds)
    for k in range(width):
        hit = _check_pipeline([(readings[i][min(k, len(readings[i]) - 1)], pipe[i][1]) for i in range(n)], known, fds)
        if hit:
            return hit
    return None


# The rules a second reading of the line (ANSI-C decoded, PowerShell script blocks) may report.
_NAMED_RULES = ("pipe_to_shell", "rc_download", "rm_root_home", "perm_root", "disk_overwrite")
_PS_BLOCK_RE = re.compile(r"(?:^|[\s;&|(=])\{\s*`?(?:remove-item|ri|rm|rd|rmdir|del|erase|iex|invoke-expression)\b", _AI)


def _pad_script_blocks(text: str) -> str:
    """The text with each { and } that is not part of a ${...} or @{...} written as a word of its own."""
    out: List[str] = []
    stack: List[bool] = []
    for i, ch in enumerate(text):
        if ch == "{":
            pad = not (i > 0 and text[i - 1] in "$@")
            if len(stack) < _MAX_SEGMENTS:
                stack.append(pad)
            out.append(" { " if pad else ch)
        elif ch == "}":
            out.append(" } " if (stack.pop() if stack else True) else ch)
        else:
            out.append(ch)
    return "".join(out)


def _analyze(cmd: str, depth: int = 0, known: Any = None) -> Optional[str]:
    text = str(cmd)
    if len(text) > _MAX_CHARS:
        return _OVERFLOW
    # PowerShell runs a command named in quotes after & or . (& 'iex', . "irm"): such a name is kept, not blanked.
    named = _PS_QUOTED_NAME_RE.sub(r"\1\3", text) if ("'" in text or '"' in text) and len(text) <= _QUOTE_SCAN_MAX else text
    bare = text if len(text) > _QUOTE_SCAN_MAX else _QUOTED_RE.sub("''", named)
    if _fork_bomb(bare):
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
        or _SHELL_STDIN_DOWNLOAD_RE.search(text)
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
        if ansi_hit in _NAMED_RULES:
            return ansi_hit
    # PowerShell script blocks: & {Remove-Item -Recurse C:\} runs the command inside the braces. The braces are read as
    # words of their own, only when one opens right before a delete command; as above, this reading only adds a block.
    if "{" in text and _PS_BLOCK_RE.search(text):
        ps_hit = _check_segments(_segments_of(_pad_script_blocks(text))[0], depth, known)
        if ps_hit in _NAMED_RULES:
            return ps_hit
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
