"""The evidence pack for auditors: a folder with the records of a date range, the result of checking
the whole hash chain, a summary, a control map in plain English, a manifest with the hash of each
file, and a README. Nothing is uploaded; the folder is written to disk.

Same bytes as the Node package (lib/evidence_pack.js). See that file for the rules: records are in
log order, a record with no valid UTC time is undated (left out when a date range is given), and
without include_preview the payload_preview field is removed from each record.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .evidence_timesketch import _json_js, _parse_record, inspect_ledger, ocsf_event, timesketch_micros

PACK_FILES = ("records.jsonl", "chain.json", "summary.json", "controls.md", "README.txt")
# Records file name per format. The ocsf format writes OCSF events for JSON-object records only.
PACK_RECORDS_FILE = {"jsonl": "records.jsonl", "ocsf": "records.ocsf.jsonl"}
PACK_FORMATS = tuple(PACK_RECORDS_FILE)

# ASCII digits only: \d would also match other Unicode digits.
_DATE_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
_NEWLINE = b"\n"

CONTROLS_TEXT = """# Control map

This map shows which records in this pack may help as evidence for these criteria. zn-gate does not make a system compliant, and this pack is not an attestation. Your auditor decides what evidence is sufficient.

Each entry gives a plain-English reading of one criterion, the records in this pack that may support it, and the fields to look at. Field names are the ones in records.jsonl. In records.ocsf.jsonl the same values sit under OCSF names, and the zn-gate fields under unmapped. The verdict is "allow" or "block".

## CC6.1 Logical access

The criterion is about limiting access to systems and data to the people and programs that need it, and checking that access.

Records that may help: records with verdict "block" show actions that zn-gate stopped. Records with verdict "allow" show actions it let through.

Where to look: verdict, agent_environment (which agent ran), tool_name (what it tried to do), rule (the rule that decided).

## CC6.6 Threats from outside the system boundary

The criterion is about protecting the system against threats that come from outside its boundary, such as untrusted content or outside connections.

Records that may help: records with a rule or a reason that concerns outside content, tool results or network use. The summary counts rule ids in summary.json.

Where to look: rule, reason, phase (the point at which the check ran), verdict.

## CC7.2 Monitoring for anomalies

The criterion is about monitoring the system for unusual activity and reviewing what the monitoring finds.

Records that may help: the block records over time, and the counts by rule in summary.json. chain.json shows whether the whole log checked out when the pack was made.

Where to look: timestamp, verdict, rule, agent_environment; chain.json fields verified and break_index.

## CC8.1 Change management

The criterion is about making changes to software, data and configuration through a controlled and authorized process.

Records that may help: records of tool calls that write or change files, settings or other systems, with the verdict that zn-gate gave them. payload_sha256 links a record to the content it checked, without storing that content.

Where to look: tool_name, verdict, rule, payload_sha256.
"""

README_TEXT = """zn-gate evidence pack
=====================

This folder holds the zn-gate records for one period, the result of checking the whole log, a summary, and a map of records that may help with a few audit criteria.

Files
- records.jsonl   the records in the period, one per line, in log order (with --format ocsf: records.ocsf.jsonl, the same records as OCSF events)
- chain.json      the result of checking the hash chain of the whole log, and the first and last record of the period
- summary.json    counts by verdict, agent and rule for the records in this folder
- controls.md     which records may help as evidence for four criteria, and where to look
- manifest.json   the sha256 and size of each file above (written last; if it is missing, the pack is incomplete)
- README.txt      this file

How to check the pack
1. Compute the sha256 of each file and compare it with manifest.json.
   Linux or macOS:  sha256sum records.jsonl chain.json summary.json controls.md README.txt
   Windows:         Get-FileHash -Algorithm SHA256 records.jsonl
2. Run "zn-gate evidence --verify" on the original log. This checks the hash chain again. The check covers the whole log, not only the period in this folder.
3. Open chain.json. "verified": true means the whole log checked out when the pack was made.

Notes
- Without --include-preview, the payload_preview field is removed from each record. Its hash is not in the pack, so re-checking the hashes needs the original log.
- A pack is a copy of records. It is not an attestation.
"""


class PackReadError(Exception):
    """The log could not be read in full: no pack is written from it."""


def _is_leap(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def parse_day(text: Any) -> Optional[str]:
    """A YYYY-MM-DD calendar date that exists, or None."""
    m = _DATE_RE.fullmatch(text) if isinstance(text, str) else None
    if not m:
        return None
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if month < 1 or month > 12:
        return None
    days = 29 if month == 2 and _is_leap(year) else _MONTH_DAYS[month - 1]
    if day < 1 or day > days:
        return None
    return text


def validate_pack_options(since: Any = None, until: Any = None, fmt: Any = "jsonl") -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Returns (options, None) or (None, one-line message). Same rules as the Node package."""
    fmt_text = (fmt or "jsonl").lower()
    if fmt_text not in PACK_FORMATS:
        shown = "".join(c if " " <= c <= "~" else "?" for c in str(fmt))[:40]
        return None, f'zn-gate: evidence pack supports --format jsonl or ocsf (got "{shown}").'
    since_day = None
    until_day = None
    if since is not None:
        since_day = parse_day(since)
        if since_day is None:
            return None, f'zn-gate: --since must be a real date in the form YYYY-MM-DD (got "{str(since)[:40]}").'
    if until is not None:
        until_day = parse_day(until)
        if until_day is None:
            return None, f'zn-gate: --until must be a real date in the form YYYY-MM-DD (got "{str(until)[:40]}").'
    if since_day is not None and until_day is not None and since_day > until_day:
        return None, "zn-gate: --since is after --until, so the period is empty."
    return {"since": since_day, "until": until_day, "format": fmt_text}, None


def pack_target_problem(out_dir: str) -> Optional[str]:
    """None when out_dir can be used for a new pack (missing, or an empty folder); else a reason."""
    if not os.path.lexists(out_dir):
        return None
    if not os.path.isdir(out_dir):
        return f"zn-gate: {out_dir} exists and is not a folder."
    if os.listdir(out_dir):
        return f"zn-gate: {out_dir} is not empty; choose a new folder."
    return None


def _sorted_counts(counts: Dict[str, int]) -> Dict[str, int]:
    return {k: counts[k] for k in sorted(counts)}


def _bump(counts: Dict[str, int], key: str) -> None:
    counts[key] = counts.get(key, 0) + 1


def _pack_line(fmt: str, chunk: bytes, rec: Optional[Dict[str, Any]], include_preview: bool,
               index: int, verified: bool) -> bytes:
    """The bytes written for one record, as the Node package's PACK_FORMATS entries give them."""
    if fmt == "ocsf":
        return (_json_js(ocsf_event(rec, index, verified, include_preview)) + "\n").encode("utf-8")
    if rec is not None and not include_preview and "payload_preview" in rec:
        rest = {k: v for k, v in rec.items() if k != "payload_preview"}
        return (_json_js(rest) + "\n").encode("utf-8")
    return chunk + _NEWLINE


def _write_new(path: str, data: bytes) -> Dict[str, Any]:
    with open(path, "xb") as f:
        f.write(data)
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def _snapshot_log(file_path: str, tmp_dir: str) -> Optional[str]:
    """Copies the log, as seen on one open file and up to its size at that moment, to a private file in
    tmp_dir. Returns the copy's path, or None when the log does not exist. Both passes read the copy."""
    try:
        src = open(file_path, "rb")
    except FileNotFoundError:
        return None
    except OSError as e:
        raise PackReadError(f"Cannot read the evidence log: {e.strerror or e}") from e
    with src:
        try:
            size = os.fstat(src.fileno()).st_size
            copy = os.path.join(tmp_dir, "evidence.jsonl")
            with open(copy, "xb") as dst:
                left = size
                while left > 0:
                    data = src.read(min(256 * 1024, left))
                    if not data:
                        raise PackReadError("Cannot read the evidence log: the log got shorter while it was read")
                    dst.write(data)
                    left -= len(data)
        except OSError as e:
            raise PackReadError(f"Cannot read the evidence log: {e.strerror or e}") from e
    return copy


def write_evidence_pack(file_path: str, out_dir: str, *, since: Optional[str] = None, until: Optional[str] = None,
                        fmt: str = "jsonl", include_preview: bool = False, generator: str = "",
                        now: Optional[datetime] = None) -> Dict[str, Any]:
    """Writes the pack into out_dir (missing or empty; see pack_target_problem). Returns
    {valid, total, records, undated, files, error}. Raises PackReadError when the log cannot be read.
    A chain that does not verify is reported, not raised: the pack is still written."""
    options, problem = validate_pack_options(since, until, fmt)
    if problem is not None:
        raise ValueError(problem)
    since_day = options["since"]
    until_day = options["until"]
    fmt_name = options["format"]
    has_range = since_day is not None or until_day is not None

    tmp_dir = tempfile.mkdtemp(prefix="zn-pack-")
    try:
        snapshot = _snapshot_log(file_path, tmp_dir)
        if snapshot is None:
            snapshot = file_path  # does not exist: an empty log
        check = inspect_ledger(snapshot)
        if check["read_error"]:
            raise PackReadError(check["error"])
        raw = b""
        if os.path.exists(snapshot):
            try:
                with open(snapshot, "rb") as f:
                    raw = f.read()
            except OSError as e:
                raise PackReadError(f"Cannot read the evidence log: {e.strerror or e}") from e
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    os.makedirs(out_dir, exist_ok=True)
    chain_index = 0
    undated = 0
    included = 0
    range_first: Optional[Dict[str, Any]] = None
    range_last: Optional[Dict[str, Any]] = None
    first_ts: Optional[str] = None
    last_ts: Optional[str] = None
    verdicts: Dict[str, int] = {}
    agents: Dict[str, int] = {}
    rules: Dict[str, int] = {}
    records_parts: List[bytes] = []
    for chunk in raw.split(b"\n"):
        stripped = chunk.strip(b" \t\r")
        if not stripped:
            continue
        index = chain_index
        chain_index += 1
        try:
            rec, parse_error = _parse_record(stripped.decode("utf-8"))
        except UnicodeDecodeError:
            rec, parse_error = None, True
        is_obj = parse_error is None and isinstance(rec, dict)
        ts = None
        if is_obj and isinstance(rec.get("timestamp"), str) and timesketch_micros(rec["timestamp"]) != "":
            ts = rec["timestamp"]
        if ts is None:
            undated += 1
            keep = not has_range
        else:
            day = ts[:10]
            keep = (since_day is None or day >= since_day) and (until_day is None or day <= until_day)
        if not keep:
            continue
        if fmt_name == "ocsf" and not is_obj:
            continue
        # A record is verified when the chain verified up to it: every record before the first break.
        verified = check["valid"] is True or index < check["broken_index"]
        records_parts.append(_pack_line(fmt_name, chunk, rec if is_obj else None, include_preview, index, verified))
        included += 1
        if ts is not None:
            if first_ts is None:
                first_ts = ts
            last_ts = ts
        if is_obj:
            if isinstance(rec.get("verdict"), str):
                _bump(verdicts, rec["verdict"])
            if isinstance(rec.get("agent_environment"), str):
                _bump(agents, rec["agent_environment"])
            if isinstance(rec.get("rule"), str) and rec["rule"] != "":
                _bump(rules, rec["rule"])
            if isinstance(rec.get("record_hash"), str):
                entry = {"chain_index": index, "record_hash": rec["record_hash"]}
                if range_first is None:
                    range_first = entry
                range_last = entry

    records_data = b"".join(records_parts)
    files: Dict[str, Any] = {}
    records_name = PACK_RECORDS_FILE[fmt_name]
    files[records_name] = _write_new(os.path.join(out_dir, records_name), records_data)

    chain = {
        "records": check["total"],
        "verified": check["valid"] is True,
        "break_index": None if check["valid"] else check["broken_index"],
        "error": None if check["valid"] else check["error"],
        "truncated_tail": check["truncated_tail"] is True,
        "tip_record_hash": check["tip_record_hash"],
        "range_records": included,
        "range_first": range_first,
        "range_last": range_last,
    }
    summary = {
        "generator": generator,
        "period": {"since": since_day, "until": until_day},
        "records": included,
        "undated": undated,
        "undated_included": not has_range,
        "first_timestamp": first_ts,
        "last_timestamp": last_ts,
        "verdicts": _sorted_counts(verdicts),
        "agents": _sorted_counts(agents),
        "rules": _sorted_counts(rules),
    }
    files["chain.json"] = _write_new(os.path.join(out_dir, "chain.json"), (_json_js(chain) + "\n").encode("utf-8"))
    files["summary.json"] = _write_new(os.path.join(out_dir, "summary.json"), (_json_js(summary) + "\n").encode("utf-8"))
    files["controls.md"] = _write_new(os.path.join(out_dir, "controls.md"), CONTROLS_TEXT.encode("utf-8"))
    files["README.txt"] = _write_new(os.path.join(out_dir, "README.txt"), README_TEXT.encode("utf-8"))
    current = now if now is not None else datetime.now(timezone.utc)
    manifest = {
        "generator": generator,
        "pack_time_utc": current.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": files,
    }
    # Written last: its presence means every file above was written.
    _write_new(os.path.join(out_dir, "manifest.json"), (_json_js(manifest) + "\n").encode("utf-8"))
    return {"valid": check["valid"] is True, "total": check["total"], "records": included,
            "undated": undated, "files": files, "error": chain["error"]}
