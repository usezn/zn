"""zn-gate reach --history: did your coding agents keep a secret of yours in their local session history?

Same command, same report and same --json schema (version 1) as the npm package
(packages/zn-gate/lib/reach/history.js). Read only, no network, nothing written.
Each history file is read in 1 MB chunks, one line at a time, and every string in
it goes through the secret rules of this package (secrets only: no personal data,
no exact values).

The result holds a closed vocabulary only: agent, file path, secret type, a count
and an action. A value, a part of a value, a prefix or a hash of a value never
leaves the scanning function.

Only the home folder of the current user is read, and no link is followed: a link
at any level below the home folder, or a history file that is a link, is skipped
and listed.
"""
from __future__ import annotations

import json
import os
import re
import stat
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

VERSION = 1
DEFAULT_MAX_SECONDS = 120
MAX_SECONDS_LIMIT = 3600
CHUNK = 1024 * 1024
# A line longer than this is not scanned (a pasted binary, for example): the file is reported as incomplete.
MAX_LINE_BYTES = 32 * 1024 * 1024
MAX_DEPTH = 6
MAX_FILES = 50000
MAX_LISTED = 200
MAX_STRINGS_PER_LINE = 200000

# Agents whose history is a plain JSON Lines file and documented. Cursor and OpenCode keep theirs in a
# database (SQLite), which this version does not read: they are reported as not scanned.
AGENTS = [
    {"id": "claude-code", "name": "Claude Code", "env_dir": "CLAUDE_CONFIG_DIR", "default_dir": [".claude"],
     "trees": [{"dir": ["projects"], "ext": ".jsonl"}], "files": [["history.jsonl"]]},
    {"id": "codex", "name": "Codex CLI", "env_dir": "CODEX_HOME", "default_dir": [".codex"],
     "trees": [{"dir": ["sessions"], "ext": ".jsonl"}], "files": [["history.jsonl"]]},
]
NOT_SCANNED = [
    {"id": "cursor", "name": "Cursor", "reason": "database"},
    {"id": "opencode", "name": "OpenCode", "reason": "database"},
]

# What to do about a secret of this type: closed text, never taken from the file.
LABELS = {
    "AWS_KEY": ("AWS access key", "in the AWS console (IAM)"),
    "AWS_SECRET": ("AWS secret access key", "in the AWS console (IAM)"),
    "ANTHROPIC_KEY": ("Anthropic API key", "in the Anthropic Console"),
    "OPENAI_KEY": ("OpenAI API key", "in the OpenAI dashboard"),
    "GITHUB_TOKEN": ("GitHub token", "in your GitHub settings"),
    "GITHUB_PAT": ("GitHub personal access token", "in your GitHub settings"),
    "GITLAB_TOKEN": ("GitLab token", "in your GitLab settings"),
    "SLACK_TOKEN": ("Slack token", "in your Slack app settings"),
    "STRIPE_KEY": ("Stripe key", "in the Stripe dashboard"),
    "GOOGLE_API_KEY": ("Google API key", "in the Google Cloud console"),
    "NPM_TOKEN": ("npm token", "on npmjs.com"),
    "PYPI_TOKEN": ("PyPI token", "on pypi.org"),
    "HF_TOKEN": ("Hugging Face token", "in your Hugging Face settings"),
    "PRIVATE_KEY": ("private key", "by creating a new key pair and removing the old public key where it is installed"),
    "JWT": ("JSON Web Token", "by signing out of that service, or asking it to revoke the token"),
    "SECRET": ("password, token or key", "at the service it belongs to"),
}
DELETE_STEP = "then delete this session file if you do not need it."

REACH_USAGE = (
    "usage: zn-gate reach [path] [--json | --sarif] [--fail-on high|medium|low|none] [--remember]\n"
    "       zn-gate reach --history [--json] [--max-seconds N]"
)
FAIL_ON = ("high", "medium", "low", "none")

_TYPE_RE = re.compile(r"^[A-Z0-9_]{1,48}$")
_MARKER_RE = re.compile(r"\[REDACTED_([A-Z0-9_]+)\]")
_TOKEN_RE = re.compile(r"__ZN_([A-Z0-9](?:[A-Z0-9_]*[A-Z0-9])?)__")
_UNSAFE_RE = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]")
_LINE_BREAK_RE = re.compile("[\r\n\t  ]+")

_rule_types: Optional[Dict[str, str]] = None


def action_for(type_: str) -> str:
    label = LABELS.get(type_)
    if label:
        return "Rotate this " + label[0] + " " + label[1] + ", " + DELETE_STEP
    return "Rotate this " + type_.lower().replace("_", " ") + " at the service it belongs to, " + DELETE_STEP


def _types() -> Dict[str, str]:
    """Rule id -> secret type, read from the marker each rule of the engine writes ([REDACTED_<TYPE>])."""
    global _rule_types
    if _rule_types is None:
        from . import rules
        out: Dict[str, str] = {rules.QUOTED_CREDENTIAL_RULE: "SECRET"}
        for table in (rules.SECRET_PATTERNS, rules.PROVIDER_SECRET_PATTERNS):
            for rule_id, _pattern, replacement in table:
                m = _MARKER_RE.search(replacement)
                if m:
                    out[rule_id] = m.group(1)
        _rule_types = out
    return _rule_types


def clean(s: Any) -> str:
    """Text that is safe to print: the cleaning reach uses for any text that comes from the disk."""
    from . import rules
    text = "" if s is None else str(s)
    text = _LINE_BREAK_RE.sub(" ", rules._strip_invisible(text))
    text, _ = rules.redact_secrets(text)
    text = _LINE_BREAK_RE.sub(" ", rules._strip_invisible(text))
    return _UNSAFE_RE.sub("?", text)


def _lstat(p: str) -> Optional[os.stat_result]:
    try:
        return os.lstat(p)
    except OSError:
        return None


def real_dir_below(base: str, parts: List[str]) -> Optional[str]:
    """Directory `parts` below `base`, walking down one level at a time with lstat: None when a level is
    missing, is not a folder, or is a link (a link could lead out of the home folder)."""
    cur = base
    for p in parts:
        cur = os.path.join(cur, p)
        st = _lstat(cur)
        if st is None or stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            return None
    return cur


def base_parts(agent: Dict[str, Any], home: str, env: Dict[str, str]) -> Optional[List[str]]:
    """The agent's config folder as parts below home: the default, or the one the environment names if it is
    inside home."""
    named = env.get(agent["env_dir"]) if env else None
    if named and isinstance(named, str):
        try:
            rel = os.path.relpath(os.path.abspath(named), home)
        except ValueError:
            return None
        if rel and rel != "." and not rel.startswith("..") and not os.path.isabs(rel):
            return rel.split(os.sep)
        # A folder outside home (or home itself) is never read.
        return None
    return list(agent["default_dir"])


def display(home: str, absolute: str) -> str:
    rel = os.path.relpath(absolute, home).replace(os.sep, "/")
    return clean("~/" + rel)


def _walk(directory: str, ext: str, depth: int, out: List[Dict[str, Any]], skipped: List[Dict[str, str]],
          agent: Dict[str, Any], home: str) -> None:
    if depth > MAX_DEPTH or len(out) >= MAX_FILES:
        return
    try:
        entries = sorted(os.scandir(directory), key=lambda e: e.name)
    except OSError:
        return
    for e in entries:
        absolute = os.path.join(directory, e.name)
        if e.is_symlink():
            skipped.append({"agent": agent["id"], "file": display(home, absolute), "reason": "symlink"})
            continue
        if e.is_dir(follow_symlinks=False):
            _walk(absolute, ext, depth + 1, out, skipped, agent, home)
            continue
        if not e.is_file(follow_symlinks=False) or not e.name.endswith(ext):
            continue
        st = _lstat(absolute)
        if st is None or not stat.S_ISREG(st.st_mode):
            continue
        out.append({"abs": absolute, "size": st.st_size, "mtime": st.st_mtime_ns / 1e6})
        if len(out) >= MAX_FILES:
            return


def collect(agent: Dict[str, Any], home: str, env: Dict[str, str],
            skipped: List[Dict[str, str]]) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    parts = base_parts(agent, home, env)
    if not parts:
        return None, []
    base = real_dir_below(home, parts)
    if not base:
        # The folder itself being a link is said, so a user is not told "nothing found" for a folder that exists.
        full = os.path.join(home, *parts)
        st = _lstat(full)
        if st is not None and stat.S_ISLNK(st.st_mode):
            skipped.append({"agent": agent["id"], "file": display(home, full), "reason": "symlink"})
        return None, []
    files: List[Dict[str, Any]] = []
    for f in agent["files"]:
        absolute = os.path.join(base, *f)
        st = _lstat(absolute)
        if st is None:
            continue
        if stat.S_ISLNK(st.st_mode):
            skipped.append({"agent": agent["id"], "file": display(home, absolute), "reason": "symlink"})
            continue
        if stat.S_ISREG(st.st_mode):
            files.append({"abs": absolute, "size": st.st_size, "mtime": st.st_mtime_ns / 1e6})
    for t in agent["trees"]:
        root = real_dir_below(base, t["dir"])
        if not root:
            continue
        _walk(root, t["ext"], 0, files, skipped, agent, home)
    return base, files


def _strings(v: Any, out: List[str]) -> List[str]:
    """Every string of 8 characters or more inside a parsed JSON value (not the keys)."""
    stack = [v]
    while stack and len(out) < MAX_STRINGS_PER_LINE:
        x = stack.pop()
        if isinstance(x, str):
            if len(x) >= 8:
                out.append(x)
        elif isinstance(x, list):
            stack.extend(x)
        elif isinstance(x, dict):
            stack.extend(x.values())
    return out


def _cut_markers(text: str, known: set) -> str:
    """Cuts out the tokens zn itself writes (__ZN_<TYPE>_<n>__, __ZN_REDACTED_<TYPE>__): a value that is
    already replaced is not counted. Anything else with the same shape is scanned."""
    if "__ZN_" not in text:
        return text
    pieces = []
    last = 0
    for m in _TOKEN_RE.finditer(text):
        inner = m.group(1)
        red = re.match(r"^REDACTED_(.+)$", inner)
        ordn = re.match(r"^(.+)_[1-9][0-9]{0,8}$", inner)
        if (red and red.group(1) in known) or (ordn and ordn.group(1) in known):
            pieces.append(text[last:m.start()])
            last = m.end()
    if not pieces:
        return text
    pieces.append(text[last:])
    return " ".join(pieces)


def scan_line(line: str, counts: Dict[str, int]) -> None:
    """Adds the secret types found in one line to counts ({TYPE: n}). Values are dropped here."""
    text = line
    if line.lstrip()[:1] in ("{", "["):
        try:
            text = "\n".join(_strings(json.loads(line), []))
        except (ValueError, RecursionError):
            text = line
    if len(text) < 8:
        return
    from . import rules
    types = _types()
    text = _cut_markers(text, set(types.values()) | {"URL_PASSWORD"})
    _redacted, detections = rules.redact_secrets(text)
    for d in detections:
        t = types.get(d["rule"])
        if t is None:
            continue
        counts[t] = counts.get(t, 0) + 1


def scan_file(abs_path: str, deadline: float) -> Dict[str, Any]:
    """Stream one file. Returns {counts, bytes, complete, reason}.
    `deadline` is a timestamp in ms: past it the file is left half read and reported so."""
    counts: Dict[str, int] = {}
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(abs_path, flags)
    except OSError:
        return {"counts": counts, "bytes": 0, "complete": False, "reason": "unreadable"}
    nbytes = 0
    complete = True
    reason: Optional[str] = None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return {"counts": counts, "bytes": 0, "complete": False, "reason": "unreadable"}
        carry: List[bytes] = []
        carry_len = 0
        dropping = False

        def flush(b: bytes) -> None:
            scan_line(b.decode("utf-8", errors="replace"), counts)

        while True:
            if time.time() * 1000 > deadline:
                complete = False
                reason = "time-limit"
                break
            buf = os.read(fd, CHUNK)
            n = len(buf)
            if n <= 0:
                break
            nbytes += n
            start = 0
            while True:
                nl = buf.find(b"\n", start) if start < n else -1
                if nl < 0:
                    break
                if dropping:
                    dropping = False
                else:
                    piece = buf[start:nl]
                    if carry_len + len(piece) <= MAX_LINE_BYTES:
                        carry.append(piece)
                        flush(carry[0] if len(carry) == 1 else b"".join(carry))
                    else:
                        complete = False
                        reason = "line-too-long"
                carry = []
                carry_len = 0
                start = nl + 1
            if start < n and not dropping:
                rest = n - start
                if carry_len + rest > MAX_LINE_BYTES:
                    dropping = True
                    carry = []
                    carry_len = 0
                    complete = False
                    reason = "line-too-long"
                else:
                    carry.append(buf[start:n])
                    carry_len += rest
        if carry_len > 0 and reason != "time-limit":
            flush(b"".join(carry))
    except Exception:  # noqa: BLE001 - any read failure is reported, never raised
        complete = False
        reason = reason or "unreadable"
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    return {"counts": counts, "bytes": nbytes, "complete": complete, "reason": reason}


def history(home: Optional[str] = None, env: Optional[Dict[str, str]] = None, max_seconds: Optional[int] = None,
            _max_ms: Optional[float] = None) -> Dict[str, Any]:
    home = os.path.abspath(home or os.path.expanduser("~"))
    env = env if env is not None else dict(os.environ)
    max_s = min(MAX_SECONDS_LIMIT, max(1, int(max_seconds or DEFAULT_MAX_SECONDS)))
    started = time.time() * 1000
    deadline = started + (_max_ms if _max_ms is not None else max_s * 1000)  # _max_ms: tests only

    skipped: List[Dict[str, str]] = []
    plan: List[Dict[str, Any]] = []
    agents: List[Dict[str, Any]] = []
    for a in AGENTS:
        base, files = collect(a, home, env, skipped)
        agents.append({"id": a["id"], "name": a["name"], "scanned": bool(base),
                       "reason": None if base else "not-found", "files": 0, "bytes": 0})
        # Newest first: the sessions most likely to hold a live key.
        files.sort(key=lambda x: -x["mtime"])
        for f in files:
            plan.append({"agent": a["id"], **f})
    for n in NOT_SCANNED:
        agents.append({"id": n["id"], "name": n["name"], "scanned": False, "reason": n["reason"], "files": 0, "bytes": 0})

    findings: List[Dict[str, Any]] = []
    incomplete: List[Dict[str, str]] = []
    not_reached = 0
    time_limit_hit = False
    by_agent: Dict[str, Dict[str, Any]] = {entry["id"]: entry for entry in agents}
    for f in plan:
        shown = display(home, f["abs"])
        if time_limit_hit or time.time() * 1000 > deadline:
            time_limit_hit = True
            not_reached += 1
            if len(incomplete) < MAX_LISTED:
                incomplete.append({"agent": f["agent"], "file": shown, "reason": "time-limit"})
            continue
        r = scan_file(f["abs"], deadline)
        entry = by_agent[f["agent"]]
        entry["files"] += 1
        entry["bytes"] += r["bytes"]
        if not r["complete"]:
            if r["reason"] == "time-limit":
                time_limit_hit = True
                not_reached += 1
            if len(incomplete) < MAX_LISTED:
                incomplete.append({"agent": f["agent"], "file": shown, "reason": r["reason"]})
        for type_ in sorted(r["counts"]):
            if not _TYPE_RE.match(type_):
                continue
            findings.append({"agent": f["agent"], "file": shown, "type": type_, "count": r["counts"][type_],
                             "action": action_for(type_)})
    for s in skipped:
        if len(incomplete) < MAX_LISTED:
            incomplete.append(s)

    findings.sort(key=lambda x: (x["agent"], -x["count"]))
    with_secrets = {(f["agent"], f["file"]) for f in findings}
    return {
        "tool": "zn-gate reach --history",
        "version": VERSION,
        "agents": agents,
        "findings": findings,
        "incomplete": incomplete,
        "totals": {
            "files_scanned": sum(a["files"] for a in agents),
            "bytes_scanned": sum(a["bytes"] for a in agents),
            "files_with_secrets": len(with_secrets),
            "secrets": sum(f["count"] for f in findings),
            "files_not_reached": not_reached,
        },
        "time_limit_hit": time_limit_hit,
        "max_seconds": max_s,
        "elapsed_ms": int(time.time() * 1000 - started),
        "notes": [
            "A key listed here may already be rotated. Check before you rotate.",
            "zn-gate cannot see what was already sent to your model provider.",
        ],
    }


def _mb(n: int) -> str:
    return ("%.1f" if n < 10 * 1024 * 1024 else "%.0f") % (n / (1024 * 1024)) + " MB"


REASONS = {
    "time-limit": "not fully scanned: the time limit was reached",
    "line-too-long": "partly scanned: a line was too long to read",
    "unreadable": "not scanned: it could not be read",
    "symlink": "not scanned: it is a link, and links are never followed",
}


def report(r: Dict[str, Any], write: Optional[Callable[[str], Any]] = None) -> int:
    w = write or sys.stdout.write

    def plural(n: int, word: str) -> str:
        return str(n) + " " + word + ("" if n == 1 else "s")

    w("\nzn-gate reach --history: did your coding agents keep a secret of yours in their session history?\n")
    w("Read: the local history files of your agents in your home folder. Nothing was sent anywhere, nothing was changed, and no value is shown.\n\n")
    for a in r["agents"]:
        if a["scanned"]:
            state = plural(a["files"], "file") + ", " + _mb(a["bytes"]) + " scanned"
        elif a["reason"] == "database":
            state = "not scanned: its history is a database, which this version does not read"
        else:
            state = "no history found"
        w("  " + a["name"].ljust(12) + " " + state + "\n")
    w("\n")
    if not r["findings"]:
        if r["incomplete"]:
            w("Nothing found in what was scanned. Some files were not fully scanned (below).\n\n")
        else:
            w("No secret found in the history files that were scanned.\n\n")
    else:
        last = None
        for f in r["findings"]:
            if f["agent"] != last:
                w(next(a for a in r["agents"] if a["id"] == f["agent"])["name"].upper() + "\n")
                last = f["agent"]
            w("  " + f["file"] + "\n")
            w("    " + str(f["count"]) + " x " + f["type"] + "\n")
            w("    Do this: " + f["action"] + "\n")
        w("\n" + plural(r["totals"]["secrets"], "secret") + " in " + plural(r["totals"]["files_with_secrets"], "file") + ".\n\n")
    if r["incomplete"]:
        w("NOT FULLY SCANNED\n")
        for i in r["incomplete"]:
            w("  " + i["file"] + ": " + REASONS.get(i["reason"], i["reason"]) + "\n")
        if r["totals"]["files_not_reached"] > len(r["incomplete"]):
            w("  and more files not reached\n")
        if r["time_limit_hit"]:
            w("Run again with a larger --max-seconds to scan them (now " + str(r["max_seconds"]) + ").\n")
        w("\n")
    for n in r["notes"]:
        w(n + "\n")
    w("\n")
    return 0


def run(args: List[str]) -> int:
    """zn-gate reach ... for the arguments after `reach`. Only --history is in this package: exit 0 when the
    report is printed, 2 for a usage error or a failure (as in the npm package)."""
    target: Optional[str] = None
    fmt = "text"
    fail_on = "none"
    remember = False
    history_mode = False
    max_seconds: Optional[int] = None

    def usage(msg: str) -> int:
        sys.stderr.write("zn-gate reach: " + msg + "\n" + REACH_USAGE + "\n")
        return 2

    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            sys.stdout.write(REACH_USAGE + "\nShows what the coding agents on this machine can reach. Read only: nothing is changed or sent.\n")
            return 0
        if a == "--remember":
            remember = True
        elif a == "--history":
            history_mode = True
        elif a == "--max-seconds" or a.startswith("--max-seconds="):
            if a == "--max-seconds":
                i += 1
                v = args[i] if i < len(args) else "undefined"
            else:
                v = a[len("--max-seconds="):]
            if not re.fullmatch(r"[0-9]{1,4}", v) or int(v) < 1 or int(v) > MAX_SECONDS_LIMIT:
                return usage("--max-seconds must be a whole number from 1 to 3600")
            max_seconds = int(v)
        elif a in ("--json", "--sarif"):
            if fmt != "text":
                return usage("choose one of --json and --sarif")
            fmt = a[2:]
        elif a == "--fail-on" or a.startswith("--fail-on="):
            if a == "--fail-on":
                i += 1
                v = args[i] if i < len(args) else "undefined"
            else:
                v = a[len("--fail-on="):]
            if v.lower() not in FAIL_ON:
                return usage("--fail-on must be one of " + ", ".join(FAIL_ON))
            fail_on = v.lower()
        elif a.startswith("-") and a != "-":
            return usage("unknown option " + a)
        else:
            if target is not None:
                return usage("only one folder at a time")
            target = a
        i += 1
    if not history_mode:
        if max_seconds is not None:
            return usage("--max-seconds goes with --history")
        return usage("only --history is in the Python package: run npx -y zn-gate reach for the rest")
    if target is not None or remember or fail_on != "none" or fmt == "sarif":
        return usage("--history reads your home folder: it takes only --json and --max-seconds")
    os.environ["ZN_STATS"] = "off"
    try:
        h = history(max_seconds=max_seconds)
    except Exception as err:  # noqa: BLE001
        sys.stderr.write("zn-gate reach: could not finish: " + str(err)[:300] + "\n")
        return 2
    if fmt == "json":
        sys.stdout.write(json.dumps(h, indent=2, ensure_ascii=False) + "\n")
    else:
        report(h)
    return 0
