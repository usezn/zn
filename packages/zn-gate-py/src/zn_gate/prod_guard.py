"""Production data guard, Python side (same rules as lib/prod-guard.js).

Finds a command that deletes a database, cloud storage or infrastructure, or force-pushes to a protected branch:

  sql_drop                  DROP DATABASE / SCHEMA / TABLE or TRUNCATE sent through psql, mysql, mariadb, sqlite3, sqlcmd,
                            clickhouse-client, usql or mongosh (-c, -e, --eval, an argument, a here-document or a here-string;
                            mongosh dropDatabase() and collection drop())
  terraform_destroy         terraform / tofu / terragrunt destroy, and apply -destroy
  kubectl_delete_namespace  kubectl / oc delete namespace
  kubectl_delete_all        kubectl / oc delete ... --all
  aws_s3_delete             aws s3 rm --recursive, aws s3 rb, aws s3api delete-bucket and delete-objects
  aws_rds_delete            aws rds delete-*
  gcloud_delete             gcloud projects | sql instances | sql databases | storage buckets | container clusters delete
  git_force_push_protected  git push --force, -f, --force-with-lease or +ref to main, master, release/* or the repository's
                            default branch

It reads the text of one command. It is a guardrail against a model's mistake, not a sandbox: it does not read a script or a
program the agent wrote and then runs, and it does not see a request sent to a cloud API with a token that was found.
"""

from __future__ import annotations

import os
import re
from typing import Dict, List, NamedTuple, Optional, Tuple

from . import destructive as _d

PROD_GUARD_RULES_VERSION = "2026-10-30.3"

_RULES: Dict[str, Tuple[str, str]] = {
    "sql_drop": ("DROP DATABASE, DROP TABLE or TRUNCATE sent to a database", "deletes a database, a table or all of its rows"),
    "terraform_destroy": ("terraform destroy (or apply -destroy)", "deletes every resource the configuration manages"),
    "kubectl_delete_namespace": ("kubectl delete namespace", "deletes the namespace and everything in it"),
    "kubectl_delete_all": ("kubectl delete --all", "deletes every object of that kind that the command selects"),
    "aws_s3_delete": (
        "a recursive or bucket-level delete in S3 (aws s3 rm --recursive, s3 rb, s3api delete-bucket or delete-objects)",
        "deletes objects or a whole bucket",
    ),
    "aws_rds_delete": ("aws rds delete-*", "deletes a database instance, cluster or snapshot"),
    "gcloud_delete": ("gcloud delete of a project, a Cloud SQL instance or database, a storage bucket or a cluster", "deletes it and what it holds"),
    "git_force_push_protected": ("a force push to a protected branch", "rewrites shared history that other people rely on"),
}
RULES = ["prod:" + k for k in _RULES]

_MAX_DEPTH = 3
_MAX_CHARS = 200 * 1024
_A = re.ASCII
_SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "rbash"}
_POWERSHELLS = {"pwsh", "powershell"}
_SQL_FLAGS = {
    "psql": ["-c", "--command"], "usql": ["-c", "--command"],
    "mysql": ["-e", "--execute"], "mariadb": ["-e", "--execute"], "mycli": ["-e", "--execute"],
    "sqlcmd": ["-Q", "-q", "--query"], "clickhouse-client": ["-q", "--query"], "clickhouse": ["-q", "--query"],
    "cockroach": ["-e", "--execute"], "sqlite3": [], "sqlite": [], "pgcli": [],
}
_MONGO_HEADS = {"mongosh", "mongo"}
_AWS_VALUE_FLAGS = {"--profile", "--region", "--endpoint-url", "--output", "--query", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--color", "--cli-binary-format"}
_KUBECTL_VALUE_FLAGS = {"-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-s", "--server", "--token", "--as", "--as-group", "--request-timeout"}
_GIT_VALUE_FLAGS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
_PUSH_VALUE_FLAGS = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}
_GCLOUD_PATHS = [
    ["projects", "delete"], ["sql", "instances", "delete"], ["sql", "databases", "delete"],
    ["storage", "buckets", "delete"], ["container", "clusters", "delete"],
]
_ECHO_HEADS = {"echo", "printf"}


class ProdGuardHit(NamedTuple):
    rule: str
    id: str
    what: str
    effect: str
    message: str
    deny: str


# ------------------------------ SQL and JavaScript text ------------------------------


def _strip_literals(s: str, js: bool) -> str:
    """The text without string literals and comments (one pass, linear). An unterminated quote is read as code."""
    out: List[str] = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c in ("'", '"'):
            j = i + 1
            closed = False
            while j < n:
                if js and s[j] == "\\":
                    j += 2
                    continue
                if s[j] == c:
                    if not js and j + 1 < n and s[j + 1] == c:
                        j += 2
                        continue
                    closed = True
                    break
                j += 1
            if not closed:
                out.append(c)
                i += 1
                continue
            out.append(" ")
            i = j + 1
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "*":
            e = s.find("*/", i + 2)
            out.append(" ")
            i = n if e < 0 else e + 2
            continue
        if (js and c == "/" and i + 1 < n and s[i + 1] == "/") or (not js and c == "-" and i + 1 < n and s[i + 1] == "-"):
            e = s.find("\n", i)
            out.append(" ")
            i = n if e < 0 else e
            continue
        out.append(c)
        i += 1
    return "".join(out)


_SQL_DROP_RE = re.compile(r"^(?:drop\s+(?:database|schema|table)\b|truncate\s+(?!\()(?:table\s+)?\S)", re.ASCII | re.IGNORECASE)
_SQL_SPLIT_RE = re.compile(r"[;\n]")
_MONGO_DROP_RE = re.compile(r"\b(?:dropDatabase|dropAllUsers|dropAllRoles)\s*\(|\.\s*drop\s*\(", _A)


def _sql_drops(text: str) -> bool:
    if not text:
        return False
    for p in _SQL_SPLIT_RE.split(_strip_literals(str(text), False)):
        if _SQL_DROP_RE.match(p.strip()):
            return True
    return False


def _mongo_drops(text: str) -> bool:
    return bool(text) and bool(_MONGO_DROP_RE.search(_strip_literals(str(text), True)))


def _inline_texts(head: str, rest: List[str]) -> List[str]:
    out: List[str] = []
    flags = _SQL_FLAGS.get(head, [])
    is_mongo = head in _MONGO_HEADS
    letter = ""
    for f in flags:
        if len(f) == 2:
            letter = f[1:]
            break
    for i, w in enumerate(rest):
        if w == "<<<":
            if i + 1 < len(rest):
                out.append(rest[i + 1])
            continue
        if w.startswith("<<<"):
            out.append(w[3:])
            continue
        if is_mongo:
            if w == "--eval":
                if i + 1 < len(rest):
                    out.append(rest[i + 1])
            elif w.startswith("--eval="):
                out.append(w[7:])
            continue
        for f in flags:
            if w == f:
                if i + 1 < len(rest):
                    out.append(rest[i + 1])
            elif f.startswith("--"):
                if w.startswith(f + "="):
                    out.append(w[len(f) + 1:])
            elif len(w) > 2 and w.startswith(f):
                out.append(w[2:])
        # A cluster of short flags that ends in the SQL flag: psql -Atc "...", mysql -Be "..."
        if letter and re.match(r"^-[A-Za-z]{2,}\Z", w, _A) and w.endswith(letter) and i + 1 < len(rest):
            out.append(rest[i + 1])
    if head in ("sqlite3", "sqlite"):
        pos = [w for w in rest if not w.startswith("-") and not w.startswith("<<")]
        out.extend(pos[1:])
    return out


# ------------------------------ here-documents ------------------------------

_HEREDOC_RE = re.compile(r"(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|\\?([A-Za-z_][A-Za-z0-9_]*))", _A)


def _split_heredocs(text: str) -> Tuple[str, List[str]]:
    """The command text without the bodies of its here-documents, and the bodies. An unterminated one is left in place."""
    if "<<" not in text:
        return text, []
    lines = text.split("\n")
    keep: List[str] = []
    docs: List[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        keep.append(line)
        if "<<" not in line:
            i += 1
            continue
        marks = []
        for m in _HEREDOC_RE.finditer(line):
            delim = m.group(2) if m.group(2) is not None else (m.group(3) if m.group(3) is not None else m.group(4))
            marks.append((m.group(1) == "-", delim))
            if len(marks) >= 8:
                break
        at = i + 1
        for dash, delim in marks:
            end = -1
            for j in range(at, len(lines)):
                l = lines[j].rstrip("\r") if lines[j].endswith("\r") else lines[j]
                if (l.lstrip("\t") if dash else l) == delim:
                    end = j
                    break
            if end < 0:
                break
            docs.append("\n".join(lines[at:end]))
            at = end + 1
        i = at if (docs and at > i + 1) else i + 1
    return "\n".join(keep), docs


# ------------------------------ the commands ------------------------------


def _flag_is(w: str, long: str) -> bool:
    return w == long or w.startswith(long + "=")


def _git_dir(cwd: str) -> Optional[Tuple[str, str]]:
    d = os.path.abspath(cwd)
    for _ in range(40):
        g = os.path.join(d, ".git")
        try:
            if os.path.isdir(g):
                return g, g
            if os.path.isfile(g):
                with open(g, "r", encoding="utf-8", errors="replace") as fh:
                    m = re.search(r"^gitdir:\s*(.+)$", fh.read(1000), re.M)
                if not m:
                    return None
                git = os.path.abspath(os.path.join(d, m.group(1).strip()))
                common = git
                try:
                    with open(os.path.join(git, "commondir"), "r", encoding="utf-8") as fh:
                        common = os.path.abspath(os.path.join(git, fh.read().strip()))
                except OSError:
                    pass
                return git, common
        except OSError:
            pass
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up
    return None


def _repo_branches(cwd: Optional[str], remote: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """The current branch and the remote's default branch, from the repository files; None when not known."""
    if not cwd:
        return None, None
    g = _git_dir(cwd)
    if not g:
        return None, None
    current = default = None
    try:
        with open(os.path.join(g[0], "HEAD"), "r", encoding="utf-8", errors="replace") as fh:
            m = re.search(r"^ref:\s*refs/heads/(.+?)\s*$", fh.read(500), re.M)
        if m:
            current = m.group(1)
    except OSError:
        pass
    rem = remote if remote and re.match(r"^[A-Za-z0-9._-]+\Z", remote, _A) else "origin"
    try:
        with open(os.path.join(g[1], "refs", "remotes", rem, "HEAD"), "r", encoding="utf-8", errors="replace") as fh:
            m = re.search(r"^ref:\s*refs/remotes/" + re.escape(rem) + r"/(.+?)\s*$", fh.read(500), re.M)
        if m:
            default = m.group(1)
    except OSError:
        pass
    return current, default


def _is_protected(branch: str, default: Optional[str]) -> bool:
    return branch in ("main", "master") or branch.startswith("release/") or (bool(default) and branch == default)


def _git_force_push(rest: List[str], cwd: Optional[str]) -> Optional[str]:
    i = 0
    dir_flag = None
    while i < len(rest) and rest[i].startswith("-"):
        f = rest[i]
        i += 1
        if f == "-C" and i < len(rest):
            dir_flag = rest[i]
        if f in _GIT_VALUE_FLAGS:
            i += 1
    if i >= len(rest) or rest[i] != "push":
        return None
    args = rest[i + 1:]
    force = False
    everything = False
    pos: List[str] = []
    k = 0
    while k < len(args):
        w = args[k]
        if w == "--":
            pos.extend(args[k + 1:])
            break
        if w.startswith("--"):
            if _flag_is(w, "--force") or _flag_is(w, "--force-with-lease") or _flag_is(w, "--force-if-includes"):
                force = True
            elif w == "--mirror" or w.startswith("--mirror="):
                force = True  # --mirror deletes and overwrites remote refs: as a force push
                everything = True
            elif w == "--all":
                everything = True
            elif w in _PUSH_VALUE_FLAGS:
                k += 1
        elif w.startswith("-") and len(w) > 1:
            if re.match(r"^-[A-Za-z]+\Z", w, _A) and "f" in w:
                force = True
            if w == "-o":
                k += 1
        else:
            pos.append(w)
        k += 1
    remote = pos[0] if pos else None
    refs = pos[1:]
    plus = any(r.startswith("+") for r in refs)
    if not force and not plus:
        return None
    where = os.path.join(cwd, dir_flag) if (dir_flag and cwd) else cwd
    current, default = _repo_branches(where, remote)
    if everything:
        return "all branches"
    branches: List[str] = []
    if not refs and current:
        branches.append(current)
    for r in refs:
        if not force and not r.startswith("+"):
            continue
        ref = r[1:] if r.startswith("+") else r
        colon = ref.find(":")
        if colon >= 0:
            ref = ref[colon + 1:]
        if ref in ("HEAD", ""):
            if current:
                branches.append(current)
            continue
        branches.append(ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref)
    for b in branches:
        if _is_protected(b, default):
            return b
    return None


def _kubectl_delete(rest: List[str]) -> Optional[str]:
    i = 0
    while i < len(rest) and (rest[i].startswith("-") or (i > 0 and rest[i - 1] in _KUBECTL_VALUE_FLAGS)):
        i += 1
    if i >= len(rest) or rest[i] != "delete":
        return None
    args = rest[i + 1:]
    k = 0
    while k < len(args) and (args[k].startswith("-") or (k > 0 and args[k - 1] in _KUBECTL_VALUE_FLAGS)):
        k += 1
    kind = (args[k] if k < len(args) else "").lower()
    if re.match(r"^(?:namespaces?|ns)(?:/|\Z)", kind, _A) or any(re.match(r"^(?:namespaces?|ns)\Z", x, _A) for x in kind.split(",")):
        return "kubectl_delete_namespace"
    if any(w in ("--all", "--all=true") for w in args):
        return "kubectl_delete_all"
    return None


def _aws_delete(rest: List[str]) -> Optional[str]:
    pos: List[str] = []
    i = 0
    while i < len(rest) and len(pos) < 2:
        w = rest[i]
        if w.startswith("-"):
            if w in _AWS_VALUE_FLAGS:
                i += 1
        else:
            pos.append(w)
        i += 1
    service = pos[0] if pos else None
    op = pos[1] if len(pos) > 1 else None
    if service == "s3":
        if op == "rb":
            return "aws_s3_delete"
        if op == "rm" and "--recursive" in rest and "--dryrun" not in rest:
            return "aws_s3_delete"
    if service == "s3api" and op in ("delete-bucket", "delete-objects"):
        return "aws_s3_delete"
    if service == "rds" and isinstance(op, str) and op.startswith("delete-"):
        return "aws_rds_delete"
    return None


def _gcloud_delete(rest: List[str]) -> Optional[str]:
    pos = [w for w in rest if not w.startswith("-")]
    for p in _GCLOUD_PATHS:
        for i in range(len(pos) - len(p) + 1):
            if pos[i:i + len(p)] == p:
                return "gcloud_delete"
    return None


def _terraform_destroy(head: str, rest: List[str]) -> Optional[str]:
    pos = [w for w in rest if not w.startswith("-")]
    if (pos and pos[0] == "destroy") or (head == "terragrunt" and "destroy" in pos):
        return "terraform_destroy"
    apply = (pos and pos[0] == "apply") or (head == "terragrunt" and "apply" in pos)
    if apply and any(re.match(r"^--?destroy(?:=(?:true|1))?\Z", w, _A) for w in rest):
        return "terraform_destroy"
    return None


def _check_simple(words: List[str], depth: int, cwd: Optional[str], docs: List[str], pipe_text: List[str]) -> Optional[Tuple[str, Optional[str]]]:
    args = _d._unwrap(words)
    if not args:
        return None
    head = _d._program_name(args[0])
    rest = args[1:]

    code = None
    if head in _SHELLS or head == "su":
        for k, w in enumerate(rest):
            if re.match(r"^-[A-Za-z]*c[A-Za-z]*\Z", w, _A):
                if k + 1 < len(rest):
                    code = rest[k + 1]
                break
    elif head == "eval":
        code = " ".join(rest)
    elif head in _POWERSHELLS:
        for k, w in enumerate(rest):
            if re.match(r"^-c(?:ommand)?\Z", w, _A | re.IGNORECASE):
                code = " ".join(rest[k + 1:])
                break
    elif head == "cmd":
        for k, w in enumerate(rest):
            if re.match(r"^/[ck]\Z", w, _A | re.IGNORECASE):
                code = " ".join(rest[k + 1:])
                break
    if code is not None and depth < _MAX_DEPTH:
        hit = _analyze(code, depth + 1, cwd)
        if hit:
            return hit
    if head in _SHELLS and code is None and docs and depth < _MAX_DEPTH:
        for body in docs:
            hit = _analyze(body, depth + 1, cwd)
            if hit:
                return hit

    if head in _SQL_FLAGS or head in _MONGO_HEADS:
        check = _mongo_drops if head in _MONGO_HEADS else _sql_drops
        if any(check(t) for t in _inline_texts(head, rest)) or any(check(b) for b in docs) or any(check(t) for t in pipe_text):
            return ("sql_drop", None)
        return None
    if head in ("terraform", "tofu", "terragrunt"):
        r = _terraform_destroy(head, rest)
        return (r, None) if r else None
    if head in ("kubectl", "oc"):
        r = _kubectl_delete(rest)
        return (r, None) if r else None
    if head == "aws":
        r = _aws_delete(rest)
        return (r, None) if r else None
    if head == "gcloud":
        r = _gcloud_delete(rest)
        return (r, None) if r else None
    if head == "git":
        b = _git_force_push(rest, cwd)
        return ("git_force_push_protected", b) if b else None
    return None


def _is_doc_word(w: str) -> bool:
    return w.startswith("<<") and not w.startswith("<<<")


def _check_segments(segs, depth: int, cwd: Optional[str], docs: List[str]):
    pipe_text: List[str] = []
    for words, sep in segs:
        seg_docs = docs if any(_is_doc_word(w) for w in words) else []
        hit = _check_simple(words, depth, cwd, seg_docs, pipe_text)
        if hit:
            return hit
        args = _d._unwrap(words)
        head = _d._program_name(args[0]) if args else ""
        if head in _ECHO_HEADS:
            pipe_text.append(" ".join(args[1:]))
        if head == "cat":
            pipe_text.extend(seg_docs)
        if sep not in ("|", "|&"):
            pipe_text = []
    return None


def _analyze(cmd: str, depth: int, cwd: Optional[str]):
    text = str(cmd)
    if len(text) > _MAX_CHARS:
        return None
    code, docs = _split_heredocs(text)
    hit = _check_segments(_d._segments_of(code)[0], depth, cwd, docs)
    if hit:
        return hit
    if "\\" in code:
        hit = _check_segments(_d._segments_of(code, True)[0], depth, cwd, docs)
        if hit:
            return hit
    if "$'" in code:
        hit = _check_segments(_d._segments_of(_d._decode_ansi_c(code), True)[0], depth, cwd, docs)
        if hit:
            return hit
    return None


def check_production_data(command: str, cwd: Optional[str] = None) -> Optional[ProdGuardHit]:
    """
    Check one shell command (Bash, sh, zsh or PowerShell text). Returns None, or a ProdGuardHit with the rule name,
    the question for an agent that can ask (message) and the text for a block (deny). cwd is the folder the command
    runs in; it is used only to read the current and default branch of a git push that names no branch.
    """
    if not isinstance(command, str) or not command:
        return None
    hit = _analyze(command, 0, cwd)
    if not hit:
        return None
    rule, detail = hit
    what, effect = _RULES[rule]
    if detail:
        what = what.replace("a protected branch", "all branches, protected ones included" if detail == "all branches" else "the protected branch " + detail)
    return ProdGuardHit(
        rule=rule,
        id="prod:" + rule,
        what=what,
        effect=effect,
        message="zn: this command is " + what + ", which " + effect
        + ". Approve only if the user asked for exactly this and the target is not production data; otherwise check first with a read-only command.",
        deny="zn blocked this: it is " + what + ", which " + effect
        + ". Next step: ask the user to confirm. If they want it, they can run it in their own terminal; do not run it yourself.",
    )
