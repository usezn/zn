"""Commands that only a person at the keyboard may run (the Python twin of the npm package's lib/broker/tty.js).

`require_human(what)` refuses when an agent variable is set, when an agent's command-line program is an ancestor
process, or when stdin or stdout is not a terminal. The variables and the process chain are a heuristic second
line of defence: an agent can remove its variables (`env -u CLAUDECODE ...`) but not its own process, and when the
process table cannot be read the check reports nothing and the other checks still apply, as in the npm package.
Only the agents' command-line programs count, never an editor app, so the integrated terminal of VS Code or
Cursor, where a person types, is not affected.
"""

import json
import os
import re
import subprocess
import sys
from typing import Any, Callable, Dict, Mapping, Optional

AGENT_ENV_VARS = (
    "CLAUDECODE",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CURSOR_AGENT",
    "OPENCODE",
    "ZN_AGENT",
)
AGENT_PROGRAMS = frozenset({"claude", "codex", "opencode", "cursor-agent"})
RUNTIMES = frozenset({"node", "nodejs", "bun", "deno"})
_AGENT_SCRIPT_RE = re.compile(
    r"[\\/](?:@anthropic-ai[\\/]claude-code|@openai[\\/]codex|opencode-ai|cursor-agent)(?:[\\/]|$)", re.IGNORECASE
)
_CLAUDE_VERSIONS_RE = re.compile(r"[\\/]claude[\\/]versions[\\/][^\\/]+$", re.IGNORECASE)
MAX_DEPTH = 32
TIMEOUT_S = 3

Proc = Dict[str, Any]  # {pid, ppid, name, argv[, created]}


class HumanRequired(Exception):
    """A person at an interactive terminal is required. `str(exc)` is the message to print."""


def _base_name(path: Any) -> str:
    name = os.path.basename(str(path or "").replace("\\", "/")).lower()
    return re.sub(r"\.(exe|cmd|bat|com)$", "", name)


def agent_of(proc: Proc) -> Optional[str]:
    """The agent program a process entry {name, argv} belongs to, or None."""
    argv = proc.get("argv") or []
    exe = _base_name(argv[0] if argv else proc.get("name"))
    name = _base_name(proc.get("name"))
    if exe in AGENT_PROGRAMS:
        return exe
    if name in AGENT_PROGRAMS:
        return name
    if argv and _CLAUDE_VERSIONS_RE.search(str(argv[0]).replace("\\", "/")):
        return "claude"
    if exe in RUNTIMES or name in RUNTIMES:
        for arg in argv[1:]:
            m = _AGENT_SCRIPT_RE.search(str(arg))
            if m:
                text = m.group(0).lower()
                if "claude-code" in text:
                    return "claude"
                if "codex" in text:
                    return "codex"
                if "opencode" in text:
                    return "opencode"
                return "cursor-agent"
    return None


def walk(pid: int, lookup: Callable[[int], Optional[Proc]]) -> Optional[str]:
    """Walks from pid's parent upwards with lookup(pid) -> entry|None; the first agent found, or None."""
    seen = set()
    cur = lookup(pid)
    nxt = int(cur["ppid"]) if cur else 0
    for _ in range(MAX_DEPTH):
        if nxt <= 0 or nxt in seen:
            break
        seen.add(nxt)
        child = cur
        cur = lookup(nxt)
        if not cur:
            return None
        # A "parent" that started after its child is another process that took the id of one that exited (Windows).
        if child and child.get("created") is not None and cur.get("created") is not None and cur["created"] > child["created"]:
            return None
        found = agent_of(cur)
        if found:
            return found
        nxt = int(cur["ppid"])
    return None


def parse_stat(text: str) -> Optional[Dict[str, Any]]:
    """/proc/<pid>/stat: the name in parentheses may hold spaces and parentheses."""
    close = text.rfind(")")
    if close < 0:
        return None
    fields = text[close + 2:].split(" ")
    try:
        ppid = int(fields[1])
    except (IndexError, ValueError):
        ppid = 0
    return {"name": text[text.find("(") + 1:close], "ppid": ppid}


def _linux_entry(pid: int) -> Optional[Proc]:
    try:
        with open("/proc/%d/stat" % pid, encoding="utf-8", errors="replace") as fh:
            st = parse_stat(fh.read())
        if not st:
            return None
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as fh:
                argv = [a for a in fh.read().decode("utf-8", "replace").split("\0") if a]
        except OSError:
            argv = []
        return {"pid": pid, "ppid": st["ppid"], "name": st["name"], "argv": argv}
    except OSError:
        return None


def parse_ps(text: str) -> Dict[int, Proc]:
    """`ps -axo pid=,ppid=,ucomm=,args=` for the whole table (macOS, and Linux without /proc)."""
    table = {}  # type: Dict[int, Proc]
    for line in str(text).split("\n"):
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$", line)
        if not m:
            continue
        args = m.group(4).strip()
        table[int(m.group(1))] = {
            "pid": int(m.group(1)),
            "ppid": int(m.group(2)),
            "name": m.group(3),
            "argv": args.split() if args else [m.group(3)],
        }
    return table


def parse_cim(text: str) -> Dict[int, Proc]:
    """Windows: JSON array of {ProcessId, ParentProcessId, Name, CommandLine, Created}."""
    table = {}  # type: Dict[int, Proc]
    try:
        rows = json.loads(str(text).strip() or "[]")
    except ValueError:
        return table
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list):
        return table
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("ProcessId"), int):
            continue
        cmd = str(r.get("CommandLine") or "")
        quoted = re.match(r'^\s*"([^"]*)"', cmd)
        words = cmd.split()
        exe = quoted.group(1) if quoted else (words[0] if words else str(r.get("Name") or ""))
        rest = re.sub(r'^\s*("[^"]*"|\S+)\s*', "", cmd)
        created = r.get("Created")
        try:
            ppid = int(r.get("ParentProcessId") or 0)
        except (TypeError, ValueError):
            ppid = 0
        table[r["ProcessId"]] = {
            "pid": r["ProcessId"],
            "ppid": ppid,
            "name": str(r.get("Name") or ""),
            "argv": [exe] + rest.split(),
            "created": created if isinstance(created, (int, float)) and created > 0 else None,
        }
    return table


def _ps_table() -> Optional[Dict[int, Proc]]:
    for ps in ("/bin/ps", "/usr/bin/ps"):
        if not os.path.exists(ps):
            continue
        try:
            r = subprocess.run([ps, "-axo", "pid=,ppid=,ucomm=,args="], capture_output=True, text=True, timeout=TIMEOUT_S)
        except (OSError, subprocess.SubprocessError):
            continue
        if r.returncode == 0:
            return parse_ps(r.stdout)
    return None


def _system_powershell() -> Optional[str]:
    """Windows PowerShell from the kernel's SystemRoot link, never from the SystemRoot variable."""
    try:
        ps = os.path.realpath("\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    except OSError:
        return None
    if not re.match(r'^[A-Za-z]:\\[^%!"]+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$', ps, re.IGNORECASE):
        return None
    return ps if os.path.exists(ps) else None


def _cim_table() -> Optional[Dict[int, Proc]]:
    ps = _system_powershell()
    if not ps:
        return None
    script = (
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,"
        "@{n='Created';e={[long](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds)}} "
        "| ConvertTo-Json -Compress"
    )
    # Its own module folder only: a module planted in the user's Documents must not replace a cmdlet.
    env = {k: v for k, v in os.environ.items() if k.lower() != "psmodulepath"}
    env["PSModulePath"] = os.path.join(os.path.dirname(ps), "Modules")
    try:
        r = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True,
                           timeout=TIMEOUT_S * 3, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_cim(r.stdout) if r.returncode == 0 else None


def agent_ancestor(pid: Optional[int] = None, platform: Optional[str] = None) -> Optional[str]:
    """'claude' | 'codex' | 'opencode' | 'cursor-agent' | None. Never raises; None when no agent program is an
    ancestor or the process table cannot be read."""
    pid = pid or os.getpid()
    platform = platform or sys.platform
    try:
        if platform.startswith("linux") and os.path.exists("/proc/self/stat"):
            return walk(pid, _linux_entry)
        table = _cim_table() if platform == "win32" else _ps_table()
        if table is None:
            return None
        return walk(pid, lambda p: table.get(p))
    except Exception:
        return None


def agent_env_detected(env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """The first agent variable that is present. Present counts, also when empty: `CLAUDECODE= zn ...` is still
    run from inside an agent."""
    env = os.environ if env is None else env
    for key in AGENT_ENV_VARS:
        if key in env:
            return key
    return None


def agent_detected(env: Optional[Mapping[str, str]] = None, ancestry: Optional[Callable[[], Optional[str]]] = None) -> Optional[str]:
    """What was detected, for the message, or None. `ancestry` replaces the process check (tests)."""
    found = agent_env_detected(env)
    if found:
        return found
    ancestor = (ancestry or agent_ancestor)()
    return "started from " + ancestor if ancestor else None


def _agent_note(agent: str) -> str:
    if agent.startswith("started from "):
        return " (zn found it was %s). If you are not using an AI agent, open a new terminal window and try again." % agent
    return " (detected %s)." % agent


def _is_tty(stream: Any) -> bool:
    isatty = getattr(stream, "isatty", None)
    try:
        return bool(isatty and isatty())
    except (OSError, ValueError):
        return False


def require_human(
    what: str,
    stdin: Any = None,
    stdout: Any = None,
    env: Optional[Mapping[str, str]] = None,
    ancestry: Optional[Callable[[], Optional[str]]] = None,
) -> None:
    """Raises HumanRequired unless a person is at an interactive terminal (stdin and stdout both a TTY, no agent
    variable, no agent program among the parent processes). The agent checks come first, as in the npm package."""
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    agent = agent_detected(env, ancestry)
    if agent:
        raise HumanRequired(what + " must be run by you in your own terminal, not by an AI agent" + _agent_note(agent))
    if not (_is_tty(stdin) and _is_tty(stdout)):
        raise HumanRequired(what + " needs an interactive terminal. Open a terminal window yourself and run it there.")
