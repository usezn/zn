"""
Cryptographic Evidence Engine for zn-gate-py.
Maintains a tamper-evident SHA-256 hash-chained audit ledger at ~/.zn/evidence.jsonl.
Pure Python stdlib. Zero external dependencies.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import random
import re
import secrets
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


def _redact(text: str) -> str:
    from .rules import mask_token_runs, redact_secrets  # local import avoids import cycles
    return mask_token_runs(redact_secrets(text)[0])

ZN_DIR = os.path.expanduser("~/.zn")
EVIDENCE_FILE = os.path.join(ZN_DIR, "evidence.jsonl")
GENESIS_HASH = "0" * 64


def _ensure_dir(file_path: str) -> None:
    # The ledger directory is private to the user (POSIX; the mode is ignored on Windows).
    dirname = os.path.dirname(file_path)
    if dirname and not os.path.exists(dirname):
        os.makedirs(dirname, mode=0o700, exist_ok=True)


def _open_for_append(file_path: str):
    """Opens the ledger for appending. New files are created 0600 and an existing
    file that is readable by others is restricted to 0600 (POSIX only)."""
    fd = os.open(file_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    if os.name == "posix" and os.fstat(fd).st_mode & 0o077:
        os.fchmod(fd, 0o600)
    return os.fdopen(fd, "a", encoding="utf-8")


class EvidenceLedgerError(Exception):
    """The ledger exists but cannot be trusted or read (invalid bytes, a broken last line, an I/O error)."""


# A damaged log makes log_evidence skip its writes. The warning is shown on the first skipped
# write and again at most every WARN_INTERVAL seconds, so a long-running process (an MCP proxy
# that runs for a whole session) does not go quiet after one line.
WARN_INTERVAL = 300.0
_last_warn: Optional[float] = None
_WS = b" \t\r"  # the only whitespace trimmed around a line (the Node package does the same)


def recovery_hint(file_path: str = EVIDENCE_FILE) -> str:
    """Tells the user how to get logging going again after damage."""
    damaged = os.path.join(os.path.dirname(file_path), "evidence.damaged.jsonl")
    if os.name == "nt":
        cmd = f'move "{file_path}" "{damaged}"'
    else:
        cmd = f'mv "{file_path}" "{damaged}"'
    return (f"To start a new log and keep the old file for review, move it aside ({cmd}); "
            "the next event starts a new chain.")


def _read_ledger(file_path: str) -> Tuple[List[str], Dict[int, str]]:
    """Reads the ledger as raw bytes and decodes it line by line.
    Returns (lines, bad) where lines are the non-empty lines (undecodable bytes replaced) and
    bad maps a 0-based line index to the reason that line is not valid UTF-8.
    Raises EvidenceLedgerError when the file cannot be read."""
    try:
        with open(file_path, "rb") as f:
            raw = f.read()
    except OSError as e:
        raise EvidenceLedgerError(f"Cannot read the evidence log: {e.strerror or e}") from e
    lines: List[str] = []
    bad: Dict[int, str] = {}
    for chunk in raw.split(b"\n"):
        chunk = chunk.strip(_WS)
        if not chunk:
            continue
        try:
            lines.append(chunk.decode("utf-8"))
        except UnicodeDecodeError as e:
            bad[len(lines)] = f"Invalid UTF-8 bytes at line {len(lines) + 1} (byte {e.start}): the log was corrupted or modified."
            lines.append(chunk.decode("utf-8", errors="replace"))
    return lines, bad


def _read_last_line(file_path: str) -> Optional[bytes]:
    """Returns the last non-empty line as bytes (None for an empty or whitespace-only file),
    reading only the end of the file."""
    try:
        with open(file_path, "rb") as f:
            size = f.seek(0, os.SEEK_END)
            window = 65536
            while True:
                start = max(0, size - window)
                f.seek(start)
                buf = f.read(size - start).rstrip(b" \t\r\n")
                if buf:
                    nl = buf.rfind(b"\n")
                    if nl >= 0 or start == 0:
                        return buf[nl + 1:].strip(_WS)
                elif start == 0:
                    return None
                window *= 2
    except OSError as e:
        raise EvidenceLedgerError(f"Cannot read the evidence log: {e.strerror or e}") from e


def _corrupt_result(total: int, index: int, error: str) -> Dict[str, Any]:
    return {"valid": False, "total": total, "verified": index, "broken_index": index, "error": error}


def get_last_hash(file_path: str = EVIDENCE_FILE) -> str:
    """Reads the record_hash of the last line in the ledger (only the end of the file is read).
    A missing or empty file is the start of a new chain (genesis). If the last line cannot be
    read or trusted this raises EvidenceLedgerError: it never falls back to genesis, which would
    silently restart the chain. Damage earlier in the file is for verify_evidence_ledger to find."""
    if not os.path.exists(file_path):
        return GENESIS_HASH
    last = _read_last_line(file_path)
    if last is None:
        return GENESIS_HASH
    try:
        last_rec = json.loads(last.decode("utf-8"))
    except UnicodeDecodeError as e:
        raise EvidenceLedgerError(f"Invalid UTF-8 bytes in the last line (byte {e.start}): the log was corrupted or modified.") from e
    except ValueError as e:
        raise EvidenceLedgerError(f"Malformed JSON in the last line: {e}") from e
    last_hash = last_rec.get("record_hash") if isinstance(last_rec, dict) else None
    if not isinstance(last_hash, str) or not _HASH_RE.fullmatch(last_hash):
        raise EvidenceLedgerError("The last record has no valid record_hash.")
    return last_hash


class EvidenceLockError(Exception):
    """The write lock stayed busy for LOCK_WAIT seconds."""


# Writers take an exclusive lock around "read the last hash + append", so two processes (for
# example two agents in the same project) cannot both chain onto the same record and fork the
# log. The lock is a sidecar file `<log>.lock` created with O_EXCL; the Node package uses the
# same file and the same rules, so the two exclude each other. A writer waits at most LOCK_WAIT
# seconds; if it cannot get the lock it skips the write (fail closed: the log is never written
# without the lock) and the caller goes on. A lock file older than LOCK_STALE seconds belongs to
# a process that died (or was suspended) and is broken. The lock holds its owner's token: a writer
# only deletes the lock while it is still its own, and checks that again just before it appends,
# so a writer that lost its lock to a takeover writes nothing.
LOCK_WAIT = 2.0
LOCK_STALE = 10.0
_WIN_BUSY = (errno.EACCES, errno.EPERM, errno.EBUSY)


def _read_lock_token(lock_path: str) -> Optional[str]:
    try:
        with open(lock_path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _acquire_lock(lock_path: str, wait: float = LOCK_WAIT) -> str:
    """Takes the lock and returns this writer's token (pid + random bytes), which is written into
    the lock file. The token lets a writer tell its own lock from one taken over after it was
    considered stale: it only releases, and only appends, while the file still holds its token."""
    deadline = time.monotonic() + wait
    token = f"{os.getpid()}:{secrets.token_hex(8)}"
    delay = 0.002
    missing = 0
    while True:
        try:
            fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, token.encode("ascii"))
            finally:
                os.close(fd)
            return token
        except FileExistsError:
            pass
        except OSError as e:
            # On Windows a lock that is being deleted answers EPERM/EACCES instead of EEXIST. If the
            # lock is not there, the real problem is permissions: report it at once, do not wait.
            if not (os.name == "nt" and e.errno in _WIN_BUSY):
                raise
            if not os.path.exists(lock_path):
                # The lock may have been deleted a moment after the error; only a repeat means a
                # real permission problem.
                missing += 1
                if missing >= 5:
                    raise
                time.sleep(0.005)
                continue
            missing = 0
        if time.monotonic() >= deadline:
            raise EvidenceLockError("another process is writing to the log")
        stale = False
        try:
            # abs(): a lock dated in the future (clock moved back) is stale too.
            stale = abs(time.time() - os.stat(lock_path).st_mtime) > LOCK_STALE
        except OSError:
            pass  # gone or unreadable: wait a moment and try again
        if stale:
            # Break it by renaming it away (atomic: when several writers try, only one rename wins),
            # then delete the renamed file. Never delete by the shared path.
            aside = f"{lock_path}.stale-{token.replace(':', '-')}"
            try:
                os.rename(lock_path, aside)
            except OSError:
                pass  # someone else broke it first
            else:
                try:
                    os.unlink(aside)
                except OSError:
                    pass
                continue
        time.sleep(delay + random.random() * delay)
        delay = min(delay * 2, 0.05)


def _owns_lock(lock_path: str, token: str) -> bool:
    return _read_lock_token(lock_path) == token


def _release_lock(lock_path: str, token: str) -> None:
    # Only remove the lock if it is still ours; after a takeover it belongs to someone else.
    if not _owns_lock(lock_path, token):
        return
    try:
        os.unlink(lock_path)
    except OSError:
        pass  # already gone


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_HASH_RE = re.compile(r"[0-9a-f]{64}")


def _canonical(record: Dict[str, Any]) -> str:
    """Canonical serialization of a record for hashing: compact JSON with UTF-8 left as is and
    lone surrogates escaped, byte for byte what JSON.stringify gives in the Node package."""
    text = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
    return _LONE_SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), text)


def _canonical_ascii(record: Dict[str, Any]) -> str:
    """The older form (non-ASCII escaped as \\uXXXX) that earlier Python versions hashed.
    Verification accepts it so existing logs stay valid; new records use _canonical."""
    return json.dumps(record, separators=(",", ":"))


_last_write_warn: Optional[float] = None


def log_evidence(event: Dict[str, Any], file_path: str = EVIDENCE_FILE,
                 lock_wait: float = LOCK_WAIT) -> Optional[Dict[str, Any]]:
    """
    Appends a cryptographically hash-chained evidence record to the ledger.
    Formula: record_hash = sha256(prev_hash + ":" + json(base_record))

    If the existing ledger is corrupt or unreadable, nothing is appended (the chain is never
    restarted), a warning is printed to stderr (first time, then at most every 5 minutes) and
    None is returned. It also returns None (with a warning) when the log cannot be written
    (permissions, disk) or the write lock stays busy for 2 seconds. This never raises for a log
    problem, so it does not block the user's command; run `zn-gate evidence --verify` for
    details. To recover from damage, move the damaged file aside (see recovery_hint): the next
    event starts a new chain.
    """
    global _last_warn, _last_write_warn
    lock_path = file_path + ".lock"
    token: Optional[str] = None
    try:
        _ensure_dir(file_path)
        token = _acquire_lock(lock_path, lock_wait)
        try:
            prev_hash = get_last_hash(file_path)
        except EvidenceLedgerError as e:
            now = time.monotonic()
            if _last_warn is None or now - _last_warn >= WARN_INTERVAL:
                _last_warn = now
                sys.stderr.write(
                    f"zn-gate: the evidence log {file_path} is damaged ({e}) "
                    "Events are not being recorded. Run 'zn-gate evidence --verify' for details. "
                    f"{recovery_hint(file_path)}\n"
                )
            return None
        final_record = _build_record(event, prev_hash)
        # Still our lock? If it was taken over (this process was stalled for over 10 s) the last
        # hash read above may be out of date: write nothing rather than fork the chain.
        if not _owns_lock(lock_path, token):
            raise EvidenceLockError("the write lock was taken over")
        with _open_for_append(file_path) as f:
            f.write(_canonical(final_record) + "\n")
        return final_record
    except (OSError, EvidenceLockError) as e:
        # A log problem (no permission, a full disk, a busy lock) must never break the caller.
        now = time.monotonic()
        if _last_write_warn is None or now - _last_write_warn >= WARN_INTERVAL:
            _last_write_warn = now
            why = str(e) if isinstance(e, EvidenceLockError) else (e.strerror or e)
            sys.stderr.write(
                f"zn-gate: cannot write to the evidence log {file_path} ({why}). "
                "Events are not being recorded; the log is left as it is.\n"
            )
        return None
    finally:
        if token is not None:
            _release_lock(lock_path, token)


def _build_record(event: Dict[str, Any], prev_hash: str) -> Dict[str, Any]:
    timestamp = datetime.now(timezone.utc).isoformat()
    record_id = f"ev_{int(time.time() * 1000):x}_{secrets.token_hex(4)}"

    # Note: a payload with a lone surrogate hashes as "?" here and as U+FFFD in the Node package,
    # so payload_sha256 differs between the two for such text; record_hash and verification are
    # not affected.
    payload_raw = event.get("payload", "")
    payload_str = payload_raw if isinstance(payload_raw, str) else json.dumps(payload_raw, separators=(",", ":"))
    payload_sha256 = hashlib.sha256(payload_str.encode("utf-8", errors="replace")).hexdigest()

    raw_conf = event.get("confidence", 1.0)
    conf_val = int(raw_conf) if isinstance(raw_conf, (int, float)) and float(raw_conf).is_integer() else float(raw_conf)

    base_record = {
        "id": record_id,
        "timestamp": timestamp,
        "agent_environment": event.get("agent") or event.get("agent_environment") or "python-agent",
        "phase": event.get("phase", "tool-call"),
        "tool_name": event.get("tool_name") or event.get("tool") or "unknown",
        "payload_sha256": payload_sha256,
        # Redact the full payload first, then cut, so a secret straddling the cut is not leaked.
        "payload_preview": (_redact(payload_str) or "")[:120],
        "verdict": event.get("verdict", "allow"),
        "rule": event.get("rule", None),
        "reason": event.get("reason", None),
        "confidence": conf_val,
        "latency_us": int(event.get("latency_us", 0)),
        "engine": event.get("engine", "python-deterministic"),
        "prev_hash": prev_hash,
    }

    hash_input = f"{prev_hash}:{_canonical(base_record)}".encode("utf-8")
    final_record = dict(base_record)
    final_record["record_hash"] = hashlib.sha256(hash_input).hexdigest()
    return final_record


def verify_evidence_ledger(file_path: str = EVIDENCE_FILE) -> Dict[str, Any]:
    """
    Verifies the cryptographic integrity of the entire ledger chain from genesis.
    Returns { "valid": bool, "total": int, "verified": int, "broken_index": Optional[int], "error": Optional[str] }
    """
    if not os.path.exists(file_path):
        return {"valid": True, "total": 0, "verified": 0, "broken_index": None, "error": None}

    try:
        lines, bad = _read_ledger(file_path)
    except EvidenceLedgerError as e:
        return _corrupt_result(0, 0, str(e))

    expected_prev = GENESIS_HASH

    for i, line in enumerate(lines):
        if i in bad:
            return _corrupt_result(len(lines), i, bad[i])
        try:
            rec = json.loads(line)
        except Exception as e:
            return {
                "valid": False,
                "total": len(lines),
                "verified": i,
                "broken_index": i,
                "error": f"Malformed JSON at line {i+1}: {e}",
            }
        if not isinstance(rec, dict):
            return _corrupt_result(len(lines), i, f"Malformed record at line {i+1}: not a JSON object.")

        rec_prev = rec.get("prev_hash")
        if rec_prev != expected_prev:
            return {
                "valid": False,
                "total": len(lines),
                "verified": i,
                "broken_index": i,
                "error": f"Broken chain link at line {i+1} (record {rec.get('id')}): expected {expected_prev[:8]}... found {str(rec_prev)[:8]}...",
            }

        recorded_hash = rec.get("record_hash")
        base_record = {k: v for k, v in rec.items() if k != "record_hash"}
        # Ensure confidence preserves whole number integer representation if whole
        if "confidence" in base_record and isinstance(base_record["confidence"], (int, float)) and float(base_record["confidence"]).is_integer():
            base_record["confidence"] = int(base_record["confidence"])
            
        # Records written by the Node package or an older version may differ in how non-ASCII
        # text is written: accept both canonical forms.
        def _hash_of(text: str) -> str:
            return hashlib.sha256(f"{expected_prev}:{text}".encode("utf-8", errors="replace")).hexdigest()

        if recorded_hash not in (_hash_of(_canonical(base_record)), _hash_of(_canonical_ascii(base_record))):
            return {
                "valid": False,
                "total": len(lines),
                "verified": i,
                "broken_index": i,
                "error": f"Tamper detected at line {i+1} (record {rec.get('id')}): hash mismatch! Log contents were modified.",
            }

        expected_prev = recorded_hash

    return {"valid": True, "total": len(lines), "verified": len(lines), "broken_index": None, "error": None}


def get_evidence_stats(file_path: str = EVIDENCE_FILE, limit: int = 50) -> Dict[str, Any]:
    """Generates aggregated stats from the evidence ledger."""
    if not os.path.exists(file_path):
        return {
            "total": 0,
            "blocks": 0,
            "allows": 0,
            "shadows": 0,
            "valid": True,
            "top_rules": {},
            "top_tools": {},
            "recent": [],
        }

    try:
        lines, bad = _read_ledger(file_path)
    except EvidenceLedgerError as e:
        return {"total": 0, "blocks": 0, "allows": 0, "shadows": 0, "valid": False, "error": str(e),
                "top_rules": {}, "top_tools": {}, "recent": []}

    blocks = 0
    allows = 0
    shadows = 0
    top_rules: Dict[str, int] = {}
    top_tools: Dict[str, int] = {}
    recent: List[Dict[str, Any]] = []

    for line in reversed(lines):
        try:
            rec = json.loads(line)
            if not isinstance(rec, dict):
                continue
            v = rec.get("verdict")
            if v == "block":
                blocks += 1
                r = rec.get("rule")
                if r:
                    top_rules[r] = top_rules.get(r, 0) + 1
            elif v == "shadow":
                shadows += 1
            else:
                allows += 1

            t = rec.get("tool_name")
            if t:
                top_tools[t] = top_tools.get(t, 0) + 1

            if len(recent) < limit:
                recent.append(rec)
        except Exception:
            continue

    check = verify_evidence_ledger(file_path)

    return {
        "total": len(lines),
        "blocks": blocks,
        "allows": allows,
        "shadows": shadows,
        "valid": check["valid"],
        "error": check.get("error"),
        "top_rules": top_rules,
        "top_tools": top_tools,
        "recent": recent,
    }


def export_evidence_ledger(file_path: Optional[str] = None, format: str = "jsonl") -> Dict[str, Any]:
    """
    Exports the evidence ledger into JSONL or CSV with cryptographic verification.
    Suitable for enterprise compliance audits (SOC 2, ISO 27001, EU AI Act Art. 12).
    """
    target_path = file_path if file_path else EVIDENCE_FILE
    norm_format = "csv" if (format or "jsonl").lower() == "csv" else "jsonl"

    if not os.path.exists(target_path):
        empty_content = (
            "timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us\n"
            if norm_format == "csv"
            else ""
        )
        return {
            "content": empty_content,
            "format": norm_format,
            "valid": True,
            "tip_hash": GENESIS_HASH,
            "total": 0,
        }

    verify_result = verify_evidence_ledger(target_path)
    try:
        lines, _bad = _read_ledger(target_path)
    except EvidenceLedgerError:
        lines = []

    tip_hash = GENESIS_HASH
    if lines:
        try:
            tip_hash = json.loads(lines[-1]).get("record_hash", GENESIS_HASH)
        except Exception:
            pass

    if norm_format == "csv":
        headers = [
            "timestamp",
            "verdict",
            "phase",
            "tool_name",
            "agent_environment",
            "rule",
            "reason",
            "payload_sha256",
            "record_hash",
            "prev_hash",
            "latency_us",
        ]
        rows = [",".join(headers)]
        for line in lines:
            try:
                obj = json.loads(line)
                row_vals = []
                for h in headers:
                    val = str(obj.get(h, "")) if obj.get(h) is not None else ""
                    escaped = val.replace('"', '""')
                    row_vals.append(f'"{escaped}"')
                rows.append(",".join(row_vals))
            except Exception:
                pass

        return {
            "content": "\n".join(rows) + "\n",
            "format": "csv",
            "valid": verify_result["valid"],
            "error": verify_result.get("error"),
            "tip_hash": tip_hash,
            "total": len(lines),
        }

    try:
        with open(target_path, "rb") as f:
            # Same line endings as reading in text mode (Windows writes CRLF).
            raw = f.read().decode("utf-8", errors="replace").replace("\r\n", "\n")
    except OSError:
        raw = ""

    return {
        "content": raw if raw.endswith("\n") else raw + "\n",
        "format": "jsonl",
        "valid": verify_result["valid"],
        "error": verify_result.get("error"),
        "tip_hash": tip_hash,
        "total": len(lines),
    }
