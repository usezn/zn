"""
CLI entrypoint for zn-gate (Python SDK).
Pure Python stdlib. Zero external dependencies.
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import stat
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import __version__
from .rules import RULES_VERSION, evaluate, mask_token_runs
from .rules import SECRET_PATTERNS as _DLP_PATTERNS, redact_secrets as _dlp_redact, redact_scan_secrets as _scan_redact
from .client import analyze, is_cloud_enabled, resolve_endpoint
from .evidence import log_evidence, verify_evidence_ledger, get_evidence_stats, export_evidence_ledger, recovery_hint, EVIDENCE_FILE

# Secrets that span several lines (a PEM private key block). The line-by-line
# scan never sees BEGIN and END together, so these run on the whole file.
# Each entry: (rule name, pattern, header pattern shown instead of the match).
_MULTILINE_RULES = [
    (name, rx, re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"))
    for name, rx, _ in _DLP_PATTERNS if name == "secret:private_key"
]

# A BEGIN marker with no END (a key cut short when pasted or truncated): the
# lines after it that look like PEM headers or base64 are treated as key
# material, up to the first empty or other line (an encrypted key has one
# empty line after its Proc-Type / DEK-Info headers, which is kept).
_KEY_BEGIN = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
_KEY_END = re.compile(r"-----END [A-Z ]*PRIVATE KEY-----")
_KEY_BODY = re.compile(r"^(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+: )")
_KEY_HEADER = re.compile(r"^[A-Za-z-]+: ")
_TRUNCATED_KEY_REASON = "Exposed credential detected by DLP filter (private key without an END marker)"

# Private key files that usually have no extension.
_KEY_FILE_NAMES = {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk", "id_xmss", "identity"}
# Files of this size or larger are not scanned, and neither are .key files
# with a NUL byte near the start (a Keynote document, not a key).
_MAX_SCAN_BYTES = 2 * 1024 * 1024
_BINARY_SNIFF = 8192
_UTF16_BOMS = (b"\xff\xfe", b"\xfe\xff")


def _decode_scan_text(raw: bytes) -> str:
    """File contents as text. UTF-16 files with a byte order mark (common on
    Windows: PowerShell output, some editors) are decoded as UTF-16."""
    if raw[:2] == b"\xff\xfe":
        return raw[2:len(raw) - len(raw) % 2].decode("utf-16-le", errors="ignore")
    if raw[:2] == b"\xfe\xff":
        return raw[2:len(raw) - len(raw) % 2].decode("utf-16-be", errors="ignore")
    return raw.decode("utf-8", errors="ignore")


# A file name is put in a suggested command only when it is made of plain
# characters and does not start with "-" (see secretNextStep in cli.js).
_SAFE_FILE_ARG = re.compile(r"[A-Za-z0-9._/@+-]+")


def _leak_next_step(file: str, rule: str) -> str:
    """What to do about a secret found by the scan, in plain words (never the
    value). The same text as secretNextStep in the Node.js package; the file
    is shown relative to the current directory, as there."""
    if rule == "secret:private_key":
        return ("Next: move the key out of this file (for example to ~/.ssh or a secret manager) "
                "and replace it if the file was ever committed or shared.")
    if re.match(r"\.env", os.path.basename(file), re.IGNORECASE):
        try:
            rel = os.path.relpath(file)
        except ValueError:  # another drive on Windows
            rel = file
        if os.sep != "/":  # Windows: npx takes forward slashes too
            rel = rel.replace(os.sep, "/")
        arg = rel if _SAFE_FILE_ARG.fullmatch(rel) and not rel.startswith("-") else "<file>"
        return (f"Next: run npx -y zn-gate env shadow {arg} to move the values into the local vault, "
                "and rotate any value that was ever committed or shared.")
    return ("Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the "
            "__ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.")

SHIELD = "\U0001f6e1\ufe0f"
ALERT = "\U0001f6a8"
CHECK = "\u2705"
LOCK = "\U0001f512"

# Plain markers used when the console cannot encode the symbols above, for
# example a Windows console with a legacy code page such as cp1252.
_ASCII_MARKERS = {SHIELD: "[+]", ALERT: "[!]", CHECK: "[ok]", LOCK: "[ok]"}


def _configure_output_streams() -> None:
    """Never crash on output encoding.

    Characters the console cannot encode (emoji, or non-ASCII text quoted from
    a scanned file) are replaced instead of raising UnicodeEncodeError. The
    stream encoding is kept, so UTF-8 terminals print exactly the same output.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None or getattr(stream, "errors", None) != "strict":
            continue
        try:
            reconfigure(errors="replace")
        except Exception:
            pass


def _plain_text() -> bool:
    """True when the environment asks for plain text: NO_COLOR set to any non-empty
    value (no-color.org) or TERM=dumb. Symbols are then left out; the words next to
    them carry the same meaning."""
    return bool(os.environ.get("NO_COLOR")) or os.environ.get("TERM") == "dumb"


def _icon(symbol: str, stream: Any = None) -> str:
    """Return `symbol` if the stream can encode it, else a plain ASCII marker ('' in plain text)."""
    if _plain_text():
        return ""
    stream = stream if stream is not None else sys.stdout
    encoding = getattr(stream, "encoding", None) or "utf-8"
    try:
        symbol.encode(encoding)
        return symbol
    except (UnicodeError, LookupError):
        return _ASCII_MARKERS.get(symbol, "")


def _lead(symbol: str, stream: Any = None) -> str:
    """The symbol and one space, or '' when there is no symbol to show."""
    icon = _icon(symbol, stream)
    return f"{icon} " if icon else ""


def cmd_test(args: argparse.Namespace) -> int:
    text = args.text
    t0 = time.perf_counter()
    assessment = evaluate(text)
    clean_text, findings = _dlp_redact(text)
    clean_text = mask_token_runs(clean_text)
    latency_us = (time.perf_counter() - t0) * 1_000_000

    if args.json:
        out = assessment.to_dict()
        out["latency_us"] = round(latency_us, 2)
        out["secrets_detected"] = len(findings)
        if findings:
            out["redacted_preview"] = clean_text
        print(json.dumps(out, indent=2))
    else:
        # The icon follows the injection verdict only. A secret found by the
        # DLP filter is reported on its own line and does not turn an ALLOW
        # into a BLOCK.
        status_icon = f"{_lead(SHIELD)}ALLOW" if assessment.allowed else f"{_lead(ALERT)}BLOCK"
        print(f"\n{status_icon} | Verdict: {assessment.verdict.upper()} (latency: {latency_us:.1f}µs)")
        print(f"Rule:       {assessment.rule}")
        if assessment.reason:
            print(f"Reason:     {assessment.reason}")
        if assessment.advisory:
            print(f"Note:       not blocked, but worth a look: {assessment.advisory['reason']} "
                  f"({assessment.advisory['rule']}).")
        if findings:
            noun = "secret" if len(findings) == 1 else "secrets"
            print(f"DLP Alert:  {len(findings)} {noun} detected (verdict unchanged). Redacted: {clean_text}")
        print(f"Confidence: {assessment.confidence * 100:.1f}%")
        print(f"Engine:     {assessment.engine} (rules: {assessment.rules_version})\n")

    # Exit code: 0 only when nothing was flagged (no block and no secret), so
    # the command can be used as a check in scripts.
    return 0 if (assessment.allowed and not findings) else 1


def cmd_analyze(args: argparse.Namespace) -> int:
    text = args.text
    options = {
        "api_key": getattr(args, "key", None) or os.environ.get("ZN_API_KEY"),
        "stage": getattr(args, "stage", None) or os.environ.get("ZN_STAGE") or "v30",
        "api_url": getattr(args, "url", None) or os.environ.get("ZN_API_URL"),
        "local_only": getattr(args, "local_only", False),
        "long_input": getattr(args, "long_input", None),
    }

    t0 = time.perf_counter()
    res = analyze(text, **options)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    res["latency_ms"] = round(elapsed_ms, 2)

    if getattr(args, "json", True):
        print(json.dumps(res, indent=2))
    else:
        print(f"Verdict: {res.get('verdict')} | Engine: {res.get('engine')} | Latency: {elapsed_ms:.2f}ms")

    return 2 if res.get("verdict") == "block" else 0


def _skip_reason(file_path: Path) -> Optional[str]:
    """Why a file that matches the scan is not read, or None."""
    try:
        st = os.lstat(file_path)
        if not stat.S_ISREG(st.st_mode):
            return "not a regular file"
        if st.st_size >= _MAX_SCAN_BYTES:
            return "2 MiB or larger"
        with open(file_path, "rb") as f:
            head = f.read(_BINARY_SNIFF)
        if file_path.suffix.lower() == ".key" and head[:2] not in _UTF16_BOMS and b"\0" in head:
            return "binary .key file, not a key"
    except OSError:
        return "cannot be read"
    return None


def _gh_property(value: str) -> str:
    """A value for a GitHub workflow command property (file=, title=)."""
    return (str(value).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            .replace(":", "%3A").replace(",", "%2C"))


def _gh_message(value: str) -> str:
    """The message of a GitHub workflow command: one line, no command of its own."""
    return str(value).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _scan_file(file_path: Path) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []
    try:
        if file_path.stat().st_size >= _MAX_SCAN_BYTES:
            return []
        raw = file_path.read_bytes()
    except Exception:
        return []
    if file_path.suffix.lower() == ".key" and raw[:2] not in _UTF16_BOMS and b"\0" in raw[:_BINARY_SNIFF]:
        return []
    content = _decode_scan_text(raw)

    # Line numbers as the line pass counts them (str.splitlines boundaries).
    starts = [0]
    for part in content.splitlines(keepends=True):
        starts.append(starts[-1] + len(part))
    # Private keys over several lines, found first: a line inside one is never
    # printed, even when another rule fires on it (the line on its own does
    # not look like a key, so it would not be redacted).
    blocks = []  # (rule, first line, last line, header)
    key_lines = set()
    for name, rx, header_rx in _MULTILINE_RULES:
        for m in rx.finditer(content):
            # A block on one line is redacted by the line pass.
            if len(m.group(0).splitlines()) < 2:
                continue
            first = bisect.bisect_right(starts, m.start())
            last = bisect.bisect_right(starts, m.end() - 1)
            h = header_rx.match(m.group(0))
            blocks.append((name, first, last, h.group(0)[:100] if h else "[REDACTED_PRIVATE_KEY]",
                           "Exposed credential detected by DLP filter"))
            key_lines.update(range(first, last + 1))

    lines = content.splitlines()
    # BEGIN markers outside any complete block: a truncated key.
    for i, line in enumerate(lines, 1):
        if i in key_lines:
            continue
        h = _KEY_BEGIN.search(line)
        if not h or _KEY_END.search(line, h.end()):
            continue  # no marker, or a whole key on one line (the line pass redacts it)
        last = i
        while last < len(lines) and not _KEY_BEGIN.search(lines[last]):
            body = lines[last].strip()
            if _KEY_BODY.match(body):
                last += 1
            elif (not body and _KEY_HEADER.match(lines[last - 1].strip())
                  and last + 1 < len(lines) and _KEY_BODY.match(lines[last + 1].strip())):
                last += 1  # the empty line after encrypted-key headers
            else:
                break
        key_lines.update(range(i, last + 1))
        blocks.append(("secret:private_key", i, last, h.group(0)[:100], _TRUNCATED_KEY_REASON))
    for i, line in enumerate(lines, 1):
        if not line.strip():
            continue
        # Snippets are printed to the terminal and, with --format github, to CI
        # logs: always show the line with any detected secret redacted.
        redacted, findings = _scan_redact(line)
        snippet = "[REDACTED_PRIVATE_KEY]" if i in key_lines else mask_token_runs(redacted.strip())[:100]
        # A scan reports every match, including the rules that only warn by default.
        res = evaluate(line, strict=True)
        if not res.allowed:
            violations.append({
                "file": str(file_path),
                "line": i,
                "rule": res.rule,
                "reason": res.reason or res.rule,
                "type": "injection",
                "content": snippet,
            })
        for finding in findings:
            violations.append({
                "file": str(file_path),
                "line": i,
                "rule": finding["rule"],
                "reason": "Exposed credential detected by DLP filter",
                "type": "secret_leak",
                "content": snippet,
                "next_step": _leak_next_step(str(file_path), finding["rule"]),
            })
    seen = {(v["line"], v["rule"]) for v in violations}
    for name, first, _last, header, reason in blocks:
        if (first, name) in seen:
            continue
        seen.add((first, name))
        # Only the BEGIN marker, never the key material.
        violations.append({
            "file": str(file_path),
            "line": first,
            "rule": name,
            "reason": reason,
            "type": "secret_leak",
            "content": header,
            "next_step": _leak_next_step(str(file_path), name),
        })
    return violations


def cmd_scan(args: argparse.Namespace) -> int:
    target_path = Path(args.path)
    if not target_path.exists():
        print(f"Error: target path not found: {target_path}", file=sys.stderr)
        return 2

    files_to_scan: List[Path] = []
    skip_dirs = {".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build", ".eggs", "target", ".next"}
    
    if getattr(args, "exclude", None):
        for ed in args.exclude.split(","):
            ed = ed.strip()
            if ed:
                skip_dirs.add(ed)

    valid_exts = {".txt", ".md", ".json", ".yaml", ".yml", ".py", ".ts", ".js", ".prompt", ".env", ".toml", ".pem", ".key"}
    if getattr(args, "include", None):
        for ie in args.include.split(","):
            ie = ie.strip().lower()
            if ie and not ie.startswith("."):
                ie = "." + ie
            if ie:
                valid_exts.add(ie)

    if target_path.is_file():
        files_to_scan.append(target_path)
    else:
        for root, dirs, files in os.walk(target_path):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for f in files:
                p = Path(root) / f
                if p.suffix.lower() in valid_exts or p.name.startswith(".env") or p.name in _KEY_FILE_NAMES:
                    files_to_scan.append(p)

    all_violations: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []
    scanned = 0
    for fp in files_to_scan:
        reason = _skip_reason(fp)
        if reason:
            skipped.append({"file": str(fp), "reason": reason})
            continue
        scanned += 1
        all_violations.extend(_scan_file(fp))

    _print_report(getattr(args, "format", "text"), scanned, skipped, all_violations)
    if all_violations and not getattr(args, "no_fail", False):
        return 1
    return 0


def _print_report(fmt: str, scanned: int, skipped: List[Dict[str, str]], all_violations: List[Dict[str, Any]]) -> None:
    """Print the scan report: rule names, fixed text, counts and redacted snippets only."""
    leak_count = sum(1 for v in all_violations if v.get("type") == "secret_leak")
    other_count = len(all_violations) - leak_count
    if fmt == "github":
        # CI logs are public: rule, reason and location only, never the snippet.
        for v in all_violations:
            if v.get("type") == "secret_leak":
                title = _gh_property("Secret found (" + str(v["rule"]) + ")")
                message = v["next_step"]
            else:
                title = _gh_property("Security Threat (" + str(v["rule"]) + ")")
                message = v["reason"]
            print(f"::error file={_gh_property(v['file'])},line={int(v['line'])},title={title}::{_gh_message(message)}")
        for s in skipped:
            print(f"::notice file={_gh_property(s['file'])},title=Not scanned::{_gh_message(s['reason'])}")
        print(f"\n[zn-gate] Scanned {scanned} files ({len(skipped)} not scanned). Found {leak_count} secrets and {other_count} security threats.")
    elif fmt == "json":
        print(json.dumps({
            "total_files": scanned,
            "total_skipped": len(skipped),
            # Every finding, secrets included (as before); total_secrets counts the secrets alone.
            "total_threats": len(all_violations),
            "total_secrets": leak_count,
            "threats": all_violations,
            "skipped": skipped,
        }, indent=2))
    else:
        print(f"\n{_lead(SHIELD)}zn-gate Security Scanner — Scanned {scanned} files")
        if skipped:
            print(f"Not scanned ({len(skipped)}):")
            for s in skipped[:20]:
                print(f"  {s['file']} ({s['reason']})")
            if len(skipped) > 20:
                print(f"  ... and {len(skipped) - 20} more")
        if not all_violations:
            print(f"{_lead(CHECK)}All scanned prompts, tool definitions, and files are clean!\n")
            return
        print(f"{_lead(ALERT)}Found {leak_count} secrets and {other_count} threat vectors:\n")
        for v in all_violations:
            label = "Secret found" if v.get("type") == "secret_leak" else "Threat"
            print(f"  {v['file']}:{v['line']} {label} [{v['rule']}] {v['reason']}")
            print(f"    Snippet: {v['content']}")
            if v.get("next_step"):
                print(f"    {v['next_step']}")
            print()


def cmd_evidence(args: argparse.Namespace) -> int:
    if getattr(args, "verify", False):
        res = verify_evidence_ledger()
        if res.get("valid"):
            print(f"\n{_lead(LOCK)}Cryptographic Evidence Ledger: ALL {res.get('total', 0)} RECORDS VERIFIED (IMMUTABLE)\n")
            return 0
        else:
            print(f"\n{_lead(ALERT, sys.stderr)}Tamper detected: {res.get('error')}", file=sys.stderr)
            print(f"{recovery_hint()}\n", file=sys.stderr)
            return 1

    if getattr(args, "export", False):
        fmt = getattr(args, "format", "jsonl")
        res = export_evidence_ledger(format=fmt)
        out_content = res.get("content", "")
        if not res.get("valid"):
            print(f"{_lead(ALERT, sys.stderr)}Tamper detected: {res.get('error')}", file=sys.stderr)
            print(recovery_hint(), file=sys.stderr)
        if getattr(args, "output", None):
            Path(args.output).write_text(out_content, encoding="utf-8")
            print(f"Exported {res.get('total')} records to {args.output} (Integrity: {'VALID' if res.get('valid') else 'TAMPERED'}).")
        else:
            print(out_content)
        return 0

    stats = get_evidence_stats()
    print(f"\n{_lead(SHIELD)}zn Evidence Ledger Stats ({EVIDENCE_FILE})")
    print(f"  Total Events   : {stats.get('total', 0)}")
    print(f"  Blocked Drops  : {stats.get('blocks', 0)}")
    print(f"  Allowed Passes : {stats.get('allows', 0)}")
    print(f"  Integrity      : {'VALID' if stats.get('valid') else 'CORRUPTED'}")
    if not stats.get("valid") and stats.get("error"):
        print(f"  Details        : {stats.get('error')}")
        print(f"  Recovery       : {recovery_hint()}")
    print()
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    has_key = bool(os.environ.get("ZN_API_KEY"))
    cloud = is_cloud_enabled()
    print(f"\n{_lead(SHIELD)}zn-gate Status (Python):")
    print(f"  Package Version : {__version__}")
    print(f"  Rules Version   : {RULES_VERSION}")
    print(f"  Python Runtime  : {sys.version.split()[0]}")
    print(f"  Active Engine   : {'Local rules + cloud for analyze (ZN_CLOUD=1)' if cloud else 'Local rules only'}")
    print(f"  Endpoint        : {resolve_endpoint() if cloud else 'None (nothing leaves this machine)'}")
    print(f"  API key         : {('Set' + ('' if cloud else ' (unused: cloud requires ZN_CLOUD=1)')) if has_key else 'Not set'}")
    print(f"  Leaves machine  : {'analyze() text only, secrets redacted locally first' if cloud else 'Nothing'}\n")
    return 0


def cmd_stats(args) -> int:
    from . import stats as _stats
    if not (isinstance(args.days, int) and 1 <= args.days <= _stats.KEEP_DAYS):
        sys.stderr.write("zn-gate stats: --days must be between 1 and {}\n".format(_stats.KEEP_DAYS))
        return 2
    days = args.days
    s = _stats.summary(days=days)
    if args.json:
        print(json.dumps(s, indent=2))
    else:
        sys.stdout.write(_stats.render(s))
    return 0


# Commands of the npm package. The Python package has none of them, so instead of
# argparse's "invalid choice" it says where they are.
NPM_ONLY_COMMANDS = frozenset({
    "hooks", "hook", "init", "check", "doctor", "unlock", "lock", "run", "secret",
    "secrets", "env", "vault", "pins", "shield", "mcp", "mcp-shield", "secrets-mcp",
    "wrap", "team", "audit", "logs", "export",
})


def npm_only_message(command: str) -> str:
    return (
        f"zn-gate {command} is in the npm package, not in this Python package.\n"
        "The Python package protects agents you build yourself (LangChain, CrewAI, "
        "LlamaIndex or plain tool calling).\n"
        "To protect Claude Code, Codex CLI, Cursor or OpenCode, run this in your own "
        "terminal (it needs Node.js 18 or later):\n"
        "  npx -y zn-gate init\n"
    )


def main() -> int:
    _configure_output_streams()
    if len(sys.argv) > 1 and sys.argv[1] in NPM_ONLY_COMMANDS:
        sys.stderr.write(npm_only_message(sys.argv[1]))
        return 2
    parser = argparse.ArgumentParser(
        prog="zn-gate",
        description="zn deterministic guardrail engine for AI agents and LLM tool calling."
    )
    parser.add_argument("--version", action="version", version=f"zn-gate {__version__} (rules: {RULES_VERSION})")
    subparsers = parser.add_subparsers(dest="command", help="Sub-commands")

    # test command
    test_parser = subparsers.add_parser("test", help="Test a single text payload against guardrail rules")
    test_parser.add_argument("text", help="Prompt or tool argument string to test")
    test_parser.add_argument("--json", action="store_true", help="Output results as JSON")

    # analyze command
    analyze_parser = subparsers.add_parser("analyze", help="Inspect a prompt (local; cloud only with ZN_CLOUD=1 + key, redacted)")
    analyze_parser.add_argument("text", help="Prompt or message to analyze")
    analyze_parser.add_argument("--key", help="API key for zn Cloud Gate")
    analyze_parser.add_argument("--stage", default="v30", help="Cloud gate stage (default: v30)")
    analyze_parser.add_argument("--url", help="Custom API endpoint URL")
    analyze_parser.add_argument("--local-only", action="store_true", help="Force local deterministic rules only")
    analyze_parser.add_argument("--long-input", choices=["windows", "off"], help="Long texts sent to the cloud: overlapping 512-token windows (default) or the first 512 tokens only")
    analyze_parser.add_argument("--json", action="store_true", default=True, help="Output results as JSON")

    # scan command
    scan_parser = subparsers.add_parser("scan", help="Scan directory or files for injection traps & secret leaks")
    scan_parser.add_argument("path", default=".", nargs="?", help="File or directory path to scan (default: current directory)")
    scan_parser.add_argument("--format", choices=["text", "json", "github"], default="text", help="Output format")
    scan_parser.add_argument("--no-fail", action="store_true", help="Do not exit with error code even if threats are found")
    scan_parser.add_argument("--include", help="Comma-separated custom extensions to include (e.g. .custom,.xml)")
    scan_parser.add_argument("--exclude", help="Comma-separated directory names to exclude")

    # evidence command
    ev_parser = subparsers.add_parser("evidence", help="Audit cryptographic evidence ledger")
    ev_parser.add_argument("--verify", action="store_true", help="Verify SHA-256 hash-chain integrity")
    ev_parser.add_argument("--export", action="store_true", help="Export audit records")
    ev_parser.add_argument("--format", choices=["jsonl", "csv"], default="jsonl", help="Export format")
    ev_parser.add_argument("--output", help="Write export output to file")

    # status command
    subparsers.add_parser("status", help="Show engine status and configuration")

    # stats command
    st_parser = subparsers.add_parser("stats", help="What zn-gate did on this machine (local counts only)")
    st_parser.add_argument("--days", type=int, default=30, help="Days to count (1-90, default 30)")
    st_parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()
    if args.command == "test":
        return cmd_test(args)
    elif args.command == "analyze":
        return cmd_analyze(args)
    elif args.command == "scan":
        return cmd_scan(args)
    elif args.command == "evidence":
        return cmd_evidence(args)
    elif args.command == "status":
        return cmd_status(args)
    elif args.command == "stats":
        return cmd_stats(args)
    else:
        parser.print_help()
        return 0


if __name__ == "__main__":
    sys.exit(main())
