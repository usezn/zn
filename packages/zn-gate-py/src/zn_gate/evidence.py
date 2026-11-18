"""
Cryptographic Evidence Engine for zn-gate-py.
Maintains a tamper-evident SHA-256 hash-chained audit ledger at ~/.zn/evidence.jsonl (or in the folder ZN_HOME names).
Pure Python stdlib. Zero external dependencies.
"""

from __future__ import annotations

import errno
import hashlib
import json
import math
import os
import random
import re
import secrets
import sys
import time
from datetime import datetime, timezone
from collections import deque
from typing import Any, Callable, Deque, Dict, Iterator, List, Optional, TextIO, Tuple


def _redact(text: str) -> str:
    from .rules import mask_token_runs, redact_secrets  # local import avoids import cycles
    return mask_token_runs(redact_secrets(text)[0])

from .stats import zn_home  # noqa: E402  (one rule for the state folder: ~/.zn or ZN_HOME)

ZN_DIR = zn_home()
EVIDENCE_FILE = os.path.join(ZN_DIR, "evidence.jsonl")
GENESIS_HASH = "0" * 64


def _ensure_dir(file_path: str) -> None:
    # The ledger directory is private to the user (POSIX; the mode is ignored on Windows).
    dirname = os.path.dirname(file_path)
    if dirname and not os.path.exists(dirname):
        os.makedirs(dirname, mode=0o700, exist_ok=True)


def _open_for_append(file_path: str) -> TextIO:
    """Opens the ledger for appending. New files are created 0600 and an existing
    file that is readable by others is restricted to 0600 (POSIX only). If the file is
    not empty and its last byte is not a newline, a newline is written first so the next
    record starts its own line (the caller holds the write lock)."""
    fd = os.open(file_path, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        st = os.fstat(fd)
        if os.name == "posix" and st.st_mode & 0o077:
            os.fchmod(fd, 0o600)
        if st.st_size > 0:
            os.lseek(fd, st.st_size - 1, os.SEEK_SET)
            if os.read(fd, 1) != b"\n":
                os.write(fd, b"\n")  # O_APPEND: always lands at the end of the file
        return os.fdopen(fd, "a", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise


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
    # NaN, infinity or a negative wait would never time out (or time out at once): use the default.
    if not (isinstance(wait, (int, float)) and not isinstance(wait, bool)
            and math.isfinite(wait) and wait >= 0):
        wait = LOCK_WAIT
    deadline = time.monotonic() + wait
    token = f"{os.getpid()}:{secrets.token_hex(8)}"
    delay = 0.002
    missing = 0
    while True:
        try:
            fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, token.encode("ascii"))
            except BaseException:
                # The lock is ours: we created it a moment ago with O_EXCL. If the token cannot be
                # written (a full disk, ENOSPC), remove the empty lock again. Left behind, it makes
                # every later writer wait for it and report that another process is writing.
                try:
                    os.close(fd)
                finally:
                    _unlink_lock(lock_path)
                raise
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
        if stale and _break_stale_lock(lock_path, token):
            continue
        time.sleep(delay + random.random() * delay)
        delay = min(delay * 2, 0.05)


# Test seams: they let a test run code between two steps of the break protocol.
_test_hooks: Dict[str, Any] = {}


def _release_mutex(mutex: str, token: str) -> None:
    """The break mutex holds its owner's token, like the lock: a breaker only deletes the mutex
    while it is still its own. If it took longer than the stale window, another breaker may have
    reclaimed it and created a new one, and deleting by path would remove that one."""
    if _read_lock_token(mutex) == token:
        try:
            os.unlink(mutex)
        except OSError:
            pass


def _reclaim_stale_mutex(mutex: str, token: str) -> None:
    """A mutex older than the stale window belongs to a breaker that died. Move it aside first
    (never delete by the shared path: a new mutex may have been created since we looked), and put
    it back with link() if what we moved turns out to be fresh."""
    try:
        if abs(time.time() - os.stat(mutex).st_mtime) <= LOCK_STALE:
            return
        if _test_hooks.get("before_mutex_reclaim"):
            _test_hooks["before_mutex_reclaim"](mutex)
        aside = f"{mutex}-reclaim-{token.replace(':', '-')}"
        os.rename(mutex, aside)
        try:
            fresh = abs(time.time() - os.stat(aside).st_mtime) <= LOCK_STALE
        except OSError:
            fresh = False
        if fresh:
            try:
                os.link(aside, mutex)
            except OSError:
                pass  # another mutex exists again: its owner checks its token
        try:
            os.unlink(aside)
        except OSError:
            pass
    except OSError:
        pass  # gone or busy: wait and retry


def _break_stale_lock(lock_path: str, token: str) -> bool:
    """Breaks a stale lock. Breakers take a short-lived `<log>.lock.break` mutex first and judge the
    lock stale again inside it: without it, a breaker that judged the old lock stale could rename
    away a fresh lock another writer had just created, and that writer would then see its lock
    "taken over" and drop its record. Returns True when the caller should retry at once."""
    mutex = lock_path + ".break"
    try:
        fd = os.open(mutex, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        # Another breaker is working. A mutex left by a dead process is removed after a while.
        _reclaim_stale_mutex(mutex, token)
        return False
    try:
        os.write(fd, token.encode("utf-8"))
    except OSError:
        # Without the token this process cannot release the mutex. The mutex is ours (just created
        # with O_EXCL), so remove it and report the error instead of leaving an empty mutex behind.
        try:
            os.close(fd)
        finally:
            _unlink_lock(mutex)
        raise
    try:
        try:
            os.close(fd)
        except OSError:
            pass
        if _test_hooks.get("after_mutex_create"):
            _test_hooks["after_mutex_create"](mutex)
        # Inside the mutex only breakers touch a stale lock, and a fresh one cannot appear while
        # the stale file still exists, so what is judged stale here is still the stale file.
        stale = False
        try:
            stale = abs(time.time() - os.stat(lock_path).st_mtime) > LOCK_STALE
        except OSError:
            pass  # gone
        if not stale:
            return True
        # Break it by renaming it away, then delete the renamed file. Never delete by the shared path.
        aside = f"{lock_path}.stale-{token.replace(':', '-')}"
        try:
            os.rename(lock_path, aside)
        except OSError:
            return False  # already gone, or busy on Windows: retry
        # Defense in depth: if what we moved is not stale after all, put it back with link()
        # (atomic, fails if a lock exists again) before deleting our copy.
        try:
            fresh = abs(time.time() - os.stat(aside).st_mtime) <= LOCK_STALE
        except OSError:
            fresh = False
        if fresh:
            try:
                os.link(aside, lock_path)
            except OSError:
                pass  # a new lock exists: its owner checks its token
        try:
            os.unlink(aside)
        except OSError:
            pass
        _sweep_stale_leftovers(lock_path)
        return True
    finally:
        if _test_hooks.get("before_mutex_release"):
            _test_hooks["before_mutex_release"](mutex)
        _release_mutex(mutex, token)


def _sweep_stale_leftovers(lock_path: str) -> None:
    """Leftovers `<log>.lock.stale-*` only exist when a process died between renaming a stale lock
    and deleting it. Remove a few old ones after a stale lock was broken; errors are ignored."""
    try:
        directory = os.path.dirname(lock_path) or "."
        prefix = os.path.basename(lock_path) + ".stale-"
        n = 0
        for name in os.listdir(directory):
            if not name.startswith(prefix):
                continue
            n += 1
            if n > 5:
                break
            try:
                p = os.path.join(directory, name)
                if abs(time.time() - os.stat(p).st_mtime) > LOCK_STALE:
                    os.unlink(p)
            except OSError:
                pass
    except OSError:
        pass


def _owns_lock(lock_path: str, token: str) -> bool:
    return _read_lock_token(lock_path) == token


def _unlink_lock(lock_path: str) -> None:
    # On Windows, deleting a file can fail for a moment while another process (a virus scanner, an
    # indexer) has it open. A lock that stays behind blocks every other writer until it goes stale,
    # so try again briefly before giving up. A missing file is fine.
    for i in range(40):
        try:
            os.unlink(lock_path)
            return
        except FileNotFoundError:
            return
        except OSError as e:
            if not (os.name == "nt" and e.errno in _WIN_BUSY) or i == 39:
                return
        time.sleep(0.005)


def _release_lock(lock_path: str, token: str) -> None:
    # Only remove the lock if it is still ours; after a takeover it belongs to someone else.
    # If the file is missing it may be renamed aside by a breaker that is about to put it back
    # (link-back): look again a few times, and delete it if it reappears with our token.
    for i in range(4):
        current = _read_lock_token(lock_path)
        if current == token:
            _unlink_lock(lock_path)
            return
        if current is not None:
            return
        if i < 3:
            time.sleep(0.005)


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_HASH_RE = re.compile(r"[0-9a-f]{64}")


def _js_number(x: float) -> str:
    """The text JavaScript's Number toString gives for a finite non-integer float."""
    from decimal import Decimal

    sign, digit_tuple, exp = Decimal(repr(x)).as_tuple()
    assert isinstance(exp, int)  # a finite float, so never 'n', 'N' or 'F'
    all_digits = "".join(map(str, digit_tuple))
    digits = all_digits.rstrip("0") or "0"
    # Decimal point position: value = 0.<digits> * 10**n
    n = len(all_digits) + exp
    k = len(digits)
    if 0 < n <= 21:
        out = digits.ljust(n, "0") if k <= n else digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("-" if e < 0 else "+") + str(abs(e))
    return ("-" if sign else "") + out


def _serialize(record: Dict[str, Any], ascii_only: bool = False, js_numbers: bool = False) -> str:
    conf = record.get("confidence")
    swap = js_numbers and isinstance(conf, float) and math.isfinite(conf) and not conf.is_integer()
    if swap and isinstance(conf, float):
        # Serialize the confidence on its own and join the parts, so no text elsewhere in the
        # record (a preview that holds a marker, say) can be rewritten as the number.
        rest = {k: v for k, v in record.items() if k != "confidence"}
        keys = list(record.keys())
        at = keys.index("confidence")
        before = {k: rest[k] for k in keys[:at]}
        after = {k: rest[k] for k in keys[at + 1:]}
        def dump(d: Dict[str, Any]) -> str:
            return json.dumps(d, separators=(",", ":"), ensure_ascii=ascii_only)

        parts = [dump(before)[1:-1], '"confidence":' + _js_number(conf), dump(after)[1:-1]]
        text = "{" + ",".join(x for x in parts if x) + "}"
    else:
        text = json.dumps(record, separators=(",", ":"), ensure_ascii=ascii_only)
    return text if ascii_only else _LONE_SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), text)


def _canonical(record: Dict[str, Any]) -> str:
    """Canonical serialization of a record for hashing: compact JSON with UTF-8 left as is, lone
    surrogates escaped and numbers written as JavaScript writes them (0.00001, not 1e-05), byte
    for byte what JSON.stringify gives in the Node package."""
    return _serialize(record, js_numbers=True)


def _canonical_ascii(record: Dict[str, Any]) -> str:
    """The older Python form (non-ASCII escaped as \\uXXXX) that earlier versions hashed.
    Verification accepts it so existing logs stay valid; new records use _canonical."""
    return _serialize(record, ascii_only=True)


def _canonical_forms(record: Dict[str, Any]) -> List[str]:
    """Every form a record may have been hashed in: the current one, the older Python forms
    (non-ASCII escaped as \\uXXXX; small numbers as Python writes them, 1e-05) and their mix.
    Verification accepts all of them so existing logs stay valid."""
    return [
        _serialize(record, js_numbers=True),
        _serialize(record),
        _serialize(record, ascii_only=True),
        _serialize(record, ascii_only=True, js_numbers=True),
    ]


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
                    f"zn-gate: the evidence log {file_path} is damaged ({e}). "
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
    # A missing or None payload is the empty string; any other non-string payload is its compact
    # JSON (so 0 is "0" and False is "false"), as in the Node package.
    payload_raw = event.get("payload")
    if isinstance(payload_raw, str):
        payload_str = payload_raw
    elif payload_raw is None:
        payload_str = ""
    else:
        payload_str = json.dumps(payload_raw, separators=(",", ":"), ensure_ascii=False)
    payload_sha256 = hashlib.sha256(payload_str.encode("utf-8", errors="replace")).hexdigest()

    # A confidence of 0 is kept as 0; only a missing or non-numeric one defaults to 1.
    raw_conf = event.get("confidence")
    if isinstance(raw_conf, bool) or not isinstance(raw_conf, (int, float)) or not math.isfinite(raw_conf):
        raw_conf = 1.0
    conf_val = int(raw_conf) if float(raw_conf).is_integer() else float(raw_conf)
    raw_lat = event.get("latency_us")
    latency = int(raw_lat) if isinstance(raw_lat, (int, float)) and not isinstance(raw_lat, bool) and math.isfinite(raw_lat) else 0

    base_record = {
        "id": record_id,
        "timestamp": timestamp,
        "agent_environment": event.get("agent") or event.get("agent_environment") or "python-agent",
        "phase": event.get("phase") or "tool-call",
        "tool_name": event.get("tool_name") or event.get("tool") or "unknown",
        "payload_sha256": payload_sha256,
        # Redact the full payload first, then cut, so a secret straddling the cut is not leaked.
        "payload_preview": (_redact(payload_str) or "")[:120],
        "verdict": event.get("verdict") or "allow",
        "rule": event.get("rule") or None,
        "reason": event.get("reason") or None,
        "confidence": conf_val,
        "latency_us": latency,
        "engine": event.get("engine") or "python-deterministic",
        "prev_hash": prev_hash,
    }

    hash_input = f"{prev_hash}:{_canonical(base_record)}".encode("utf-8")
    final_record = dict(base_record)
    final_record["record_hash"] = hashlib.sha256(hash_input).hexdigest()
    return final_record


# The last line of a ledger that is not JSON is most likely a write cut off by a crash or a full
# disk. It is still reported as not verified (valid: False), but with truncated_tail: True so the
# output can say so and explain how to continue. Any other problem stays a tamper report.
TRUNCATED_TAIL_MESSAGE = "Last record is incomplete: the write was cut off (for example by a crash or a full disk) or the end of the file was removed, so it cannot be verified"


# A last line that is not JSON counts as a write cut off by a crash or a full disk only if it is
# the last line, the file does not end with a newline (every complete write does), and the line
# starts like a written record. Anything else stays a tamper report.
_RECORD_START = '{"id":"ev_'


def _ends_with_newline(file_path: str) -> bool:
    try:
        with open(file_path, "rb") as f:
            size = f.seek(0, os.SEEK_END)
            if size == 0:
                return True
            f.seek(size - 1)
            return f.read(1) == b"\n"
    except OSError:
        return True


def _is_cut_tail(file_path: str, line: str) -> bool:
    return line.startswith(_RECORD_START) and not _ends_with_newline(file_path)


def _truncated_tail_result(total: int, index: int) -> Dict[str, Any]:
    return {
        "valid": False,
        "total": total,
        "verified": index,
        "broken_index": index,
        "error": f"{TRUNCATED_TAIL_MESSAGE} at line {index+1}: the line is not valid JSON.",
        "truncated_tail": True,
    }


_CSV_HEADERS = [
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
_CSV_HEADER_LINE = ",".join(_CSV_HEADERS)
# CSV rows are handed out in batches of about this many characters.
_CSV_BATCH = 256 * 1024


def _csv_row(obj: Dict[str, Any]) -> str:
    row_vals = []
    for h in _CSV_HEADERS:
        val = str(obj.get(h, "")) if obj.get(h) is not None else ""
        escaped = val.replace('"', '""')
        row_vals.append(f'"{escaped}"')
    return ",".join(row_vals)


def _scan_ledger(file_path: str, fmt: str = "none", state: Optional[Dict[str, Any]] = None,
                 on_record: Optional[Callable[[Any, int], None]] = None) -> Iterator[str]:
    """Reads the ledger once, line by line, checking the hash chain as it goes, and yields the
    export text in pieces: fmt is "jsonl", "csv" or "none" (check only, nothing is yielded).
    When the generator finishes, state["result"] holds the same fields verify_evidence_ledger
    returns, plus "tip_hash". on_record(rec, index) is called for every line that parses as JSON,
    in order, so a caller can count in the same pass. Peak memory does not depend on the size of
    the log. Raises EvidenceLedgerError if the file cannot be read in full."""
    if state is None:
        state = {}
    try:
        f = open(file_path, "rb")
    except OSError as e:
        raise EvidenceLedgerError(f"Cannot read the evidence log: {e.strerror or e}") from e

    expected_prev = GENESIS_HASH
    failure: Optional[Dict[str, Any]] = None
    total = 0
    last_rec: Any = None
    last_ok = False
    # The line before the current one, held back until we know whether it is the last: a
    # malformed last line can be a write cut off by a crash.
    held: Optional[Tuple[int, str, Any, Optional[Exception], Optional[str]]] = None
    csv_parts: List[str] = []
    csv_len = 0
    if fmt == "csv":
        csv_parts.append(_CSV_HEADER_LINE + "\n")
        csv_len = len(_CSV_HEADER_LINE) + 1
    wrote_any = False
    last_piece_nl = True

    def check(entry: Tuple[int, str, Any, Optional[Exception], Optional[str]], is_last: bool) -> Optional[Dict[str, Any]]:
        nonlocal expected_prev
        i, line, rec, parse_error, bad_reason = entry
        if bad_reason is not None:
            return _corrupt_result(0, i, bad_reason)
        if parse_error is not None:
            if is_last and _is_cut_tail(file_path, line):
                return {"truncated": i}
            return {"valid": False, "verified": i, "broken_index": i,
                    "error": f"Malformed JSON at line {i+1}: {parse_error}"}
        if not isinstance(rec, dict):
            return _corrupt_result(0, i, f"Malformed record at line {i+1}: not a JSON object.")

        rec_prev = rec.get("prev_hash")
        if rec_prev != expected_prev:
            return {
                "valid": False,
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
        prev = expected_prev
        hashes = {hashlib.sha256(f"{prev}:{text}".encode("utf-8", errors="replace")).hexdigest()
                  for text in _canonical_forms(base_record)}
        if recorded_hash not in hashes:
            return {
                "valid": False,
                "verified": i,
                "broken_index": i,
                "error": f"Tamper detected at line {i+1} (record {rec.get('id')}): hash mismatch! Log contents were modified.",
            }

        expected_prev = recorded_hash
        return None

    try:
        with f:
            for raw in f:
                if fmt == "jsonl":
                    # Same line endings as reading in text mode (Windows writes CRLF).
                    piece = raw.decode("utf-8", errors="replace").replace("\r\n", "\n")
                    wrote_any = True
                    last_piece_nl = piece.endswith("\n")
                    yield piece
                chunk = raw.strip(_WS + b"\n")
                if not chunk:
                    continue
                bad_reason: Optional[str] = None
                try:
                    line = chunk.decode("utf-8")
                except UnicodeDecodeError as e:
                    bad_reason = f"Invalid UTF-8 bytes at line {total + 1} (byte {e.start}): the log was corrupted or modified."
                    line = chunk.decode("utf-8", errors="replace")
                rec: Any = None
                parse_error: Optional[Exception] = None
                try:
                    rec = json.loads(line)
                except Exception as e:
                    parse_error = e
                if held is not None and failure is None:
                    failure = check(held, False)
                held = (total, line, rec, parse_error, bad_reason)
                total += 1
                last_rec, last_ok = rec, parse_error is None
                if parse_error is None:
                    if on_record is not None:
                        on_record(rec, total - 1)
                    if fmt == "csv" and isinstance(rec, dict):
                        try:
                            row = _csv_row(rec)
                        except Exception:
                            row = None
                        if row is not None:
                            csv_parts.append(row + "\n")
                            csv_len += len(row) + 1
                if csv_len >= _CSV_BATCH:
                    yield "".join(csv_parts)
                    csv_parts = []
                    csv_len = 0
    except OSError as e:
        raise EvidenceLedgerError(f"Cannot read the evidence log: {e.strerror or e}") from e

    if held is not None and failure is None:
        failure = check(held, True)

    if fmt == "jsonl":
        # The export always ends with a newline (an empty log gives one newline).
        if not wrote_any or not last_piece_nl:
            yield "\n"
    elif fmt == "csv" and csv_parts:
        yield "".join(csv_parts)

    tip_hash: Any = GENESIS_HASH
    if last_ok and isinstance(last_rec, dict):
        tip_hash = last_rec.get("record_hash", GENESIS_HASH)

    if failure is None:
        result: Dict[str, Any] = {"valid": True, "total": total, "verified": total, "broken_index": None, "error": None}
    elif "truncated" in failure:
        result = _truncated_tail_result(total, failure["truncated"])
    else:
        result = dict(failure)
        result["total"] = total
        result.setdefault("valid", False)
    result["tip_hash"] = tip_hash
    state["result"] = result


def _run_scan(file_path: str, fmt: str = "none", on_record: Optional[Callable[[Any, int], None]] = None) -> Dict[str, Any]:
    state: Dict[str, Any] = {}
    for _piece in _scan_ledger(file_path, fmt, state, on_record):
        pass
    return state["result"]


def _check_fields(result: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: result[k] for k in ("valid", "total", "verified", "broken_index", "error")}
    if result.get("truncated_tail"):
        out["truncated_tail"] = True
    return out


def verify_evidence_ledger(file_path: str = EVIDENCE_FILE) -> Dict[str, Any]:
    """
    Verifies the cryptographic integrity of the entire ledger chain from genesis.
    The log is read once, line by line, so memory does not grow with its size.
    Returns { "valid": bool, "total": int, "verified": int, "broken_index": Optional[int], "error": Optional[str] }
    """
    if not os.path.exists(file_path):
        return {"valid": True, "total": 0, "verified": 0, "broken_index": None, "error": None}

    try:
        result = _run_scan(file_path)
    except EvidenceLedgerError as e:
        return _corrupt_result(0, 0, str(e))
    return _check_fields(result)


def get_evidence_stats(file_path: str = EVIDENCE_FILE, limit: int = 50) -> Dict[str, Any]:
    """Generates aggregated stats from the evidence ledger (one pass: the chain is checked while counting)."""
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

    # Earlier versions walked the lines from the newest, so the dicts list names in the order of
    # their last use and `recent` is newest first: both are rebuilt that way, keeping only the
    # newest `limit` records in memory.
    counts = {"blocks": 0, "allows": 0, "shadows": 0}
    rule_count: Dict[Any, int] = {}
    rule_last: Dict[Any, int] = {}
    tool_count: Dict[Any, int] = {}
    tool_last: Dict[Any, int] = {}
    keep = limit > 0
    newest: Deque[Dict[str, Any]] = deque(
        maxlen=None if limit == float("inf") else (int(math.ceil(limit)) if keep else 1))

    def on_record(rec: Any, i: int) -> None:
        try:
            if not isinstance(rec, dict):
                return
            v = rec.get("verdict")
            if v == "block":
                counts["blocks"] += 1
                r = rec.get("rule")
                if r:
                    rule_count[r] = rule_count.get(r, 0) + 1
                    rule_last[r] = i
            elif v == "shadow":
                counts["shadows"] += 1
            else:
                counts["allows"] += 1

            t = rec.get("tool_name")
            if t:
                tool_count[t] = tool_count.get(t, 0) + 1
                tool_last[t] = i

            if keep:
                newest.append(rec)
        except Exception:
            return

    try:
        check = _run_scan(file_path, "none", on_record)
    except EvidenceLedgerError as e:
        return {"total": 0, "blocks": 0, "allows": 0, "shadows": 0, "valid": False, "error": str(e),
                "top_rules": {}, "top_tools": {}, "recent": []}

    top_rules = {k: rule_count[k] for k in sorted(rule_count, key=lambda k: -rule_last[k])}
    top_tools = {k: tool_count[k] for k in sorted(tool_count, key=lambda k: -tool_last[k])}

    return {
        "total": check["total"],
        "blocks": counts["blocks"],
        "allows": counts["allows"],
        "shadows": counts["shadows"],
        "valid": check["valid"],
        "error": check.get("error"),
        "top_rules": top_rules,
        "top_tools": top_tools,
        "recent": list(reversed(newest)) if keep else [],
    }


def write_evidence_export(file_path: Optional[str], format: str, out: TextIO) -> Dict[str, Any]:
    """Streams the export of the ledger to a text stream in bounded memory, checking the hash chain
    as it reads. Returns { "format", "valid", "error", "tip_hash", "total" }. Raises
    EvidenceLedgerError if the log cannot be read in full."""
    target_path = file_path if file_path else EVIDENCE_FILE
    norm_format = "csv" if (format or "jsonl").lower() == "csv" else "jsonl"
    if not os.path.exists(target_path):
        if norm_format == "csv":
            out.write(_CSV_HEADER_LINE + "\n")
        return {"format": norm_format, "valid": True, "error": None, "tip_hash": GENESIS_HASH, "total": 0}
    state: Dict[str, Any] = {}
    written = False
    try:
        for piece in _scan_ledger(target_path, norm_format, state):
            written = True
            out.write(piece)
    except EvidenceLedgerError as e:
        if written:
            raise
        # A log that cannot be opened exports nothing and is not valid.
        out.write(_CSV_HEADER_LINE + "\n" if norm_format == "csv" else "\n")
        return {"format": norm_format, "valid": False, "error": str(e), "tip_hash": GENESIS_HASH, "total": 0}
    res = state["result"]
    return {"format": norm_format, "valid": res["valid"], "error": res.get("error"),
            "tip_hash": res["tip_hash"], "total": res["total"]}


def export_evidence_ledger(file_path: Optional[str] = None, format: str = "jsonl") -> Dict[str, Any]:
    """
    Exports the evidence ledger into JSONL or CSV with cryptographic verification.
    Suitable for enterprise compliance audits (SOC 2, ISO 27001, EU AI Act Art. 12).
    This returns the whole export as one string, so it suits small logs; the command line
    streams it (see write_evidence_export).
    """
    target_path = file_path if file_path else EVIDENCE_FILE
    norm_format = "csv" if (format or "jsonl").lower() == "csv" else "jsonl"

    if not os.path.exists(target_path):
        empty_content = _CSV_HEADER_LINE + "\n" if norm_format == "csv" else ""
        return {
            "content": empty_content,
            "format": norm_format,
            "valid": True,
            "tip_hash": GENESIS_HASH,
            "total": 0,
        }

    state: Dict[str, Any] = {}
    parts: List[str] = []
    try:
        for piece in _scan_ledger(target_path, norm_format, state):
            parts.append(piece)
    except EvidenceLedgerError as e:
        # A log that cannot be read exports nothing and is not valid.
        return {
            "content": _CSV_HEADER_LINE + "\n" if norm_format == "csv" else "\n",
            "format": norm_format,
            "valid": False,
            "error": str(e),
            "tip_hash": GENESIS_HASH,
            "total": 0,
        }
    res = state["result"]
    return {
        "content": "".join(parts),
        "format": norm_format,
        "valid": res["valid"],
        "error": res.get("error"),
        "tip_hash": res["tip_hash"],
        "total": res["total"],
    }
