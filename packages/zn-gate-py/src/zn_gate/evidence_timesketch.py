"""
Timesketch exports of the evidence ledger: 'timesketch' (JSON Lines) and 'timesketch-csv'.

Timesketch needs message, datetime and timestamp_desc on every event (the CSV also takes timestamp
in microseconds); every other key becomes a searchable attribute. The message is built only from
the verdict, tool, agent and rule id, and payload_preview (text the agent wrote) is never exported.
The output is byte-for-byte what the Node package (lib/evidence_export.js) writes for the same
ledger: the value rendering below follows JavaScript's String() and JSON.stringify().
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from .evidence import (
    GENESIS_HASH,
    _RECORD_START,
    EvidenceLedgerError,
    _canonical_forms,
    _corrupt_result,
    _ends_with_newline,
    _js_number,
    _read_ledger,
    _truncated_tail_result,
)

TIMESKETCH_FORMATS = ("timesketch", "timesketch-csv")
TIMESKETCH_DESC = "zn-gate hook decision"
TIMESKETCH_DATA_TYPE = "zn:gate:decision"
TIMESKETCH_RECORD_FIELDS = (
    ("zn_id", "id"),
    ("zn_agent", "agent_environment"),
    ("zn_phase", "phase"),
    ("zn_tool", "tool_name"),
    ("zn_verdict", "verdict"),
    ("zn_rule", "rule"),
    ("zn_reason", "reason"),
    ("zn_confidence", "confidence"),
    ("zn_engine", "engine"),
    ("zn_latency_us", "latency_us"),
    ("zn_payload_sha256", "payload_sha256"),
    ("zn_record_hash", "record_hash"),
    ("zn_prev_hash", "prev_hash"),
)
TIMESKETCH_CSV_HEADERS = (
    ["message", "datetime", "timestamp", "timestamp_desc", "data_type"]
    + [key for key, _ in TIMESKETCH_RECORD_FIELDS]
    + ["zn_chain_index", "zn_chain_verified"]
)
TIMESKETCH_CSV_HEADER_LINE = ",".join(TIMESKETCH_CSV_HEADERS)

_UTC_ISO_RE = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?Z"
)
_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
_MAX_SAFE_INTEGER = 2 ** 53
_ARRAY_INDEX_RE = re.compile(r"(?:0|[1-9][0-9]*)")
_LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")
_JSON_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


# --------------------------------------------------------------------------- JavaScript values

def _number_text(x: float) -> str:
    """String(x) for a JavaScript number that came from a parsed JSON value."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    return _js_number(x)


def _json_string(s: str) -> str:
    """JSON.stringify of a string: lone surrogates escaped, U+007F and non-ASCII left as they are."""
    out = ['"']
    for ch in s:
        esc = _JSON_ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif ord(ch) < 0x20 or 0xD800 <= ord(ch) <= 0xDFFF:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _js_key_order(obj: Dict[str, Any]) -> List[str]:
    """Own keys in the order JavaScript enumerates them: array-index keys ascending, then the rest."""
    index_keys = [k for k in obj if _ARRAY_INDEX_RE.fullmatch(k) and int(k) < 2 ** 32 - 1]
    index_keys.sort(key=int)
    other = [k for k in obj if not (_ARRAY_INDEX_RE.fullmatch(k) and int(k) < 2 ** 32 - 1)]
    return index_keys + other


def _json_js(value: Any) -> str:
    """JSON.stringify(value) for a value that came from json.loads with the JavaScript number rules."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return "null" if not math.isfinite(value) else _number_text(value)
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(_json_js(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(_json_string(k) + ":" + _json_js(value[k]) for k in _js_key_order(value)) + "}"
    raise TypeError(f"not a JSON value: {type(value).__name__}")


def _scalar_text(value: Any) -> str:
    """String(value) for a scalar; a lone surrogate becomes U+FFFD, as TextEncoder writes it."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number_text(value)
    return _LONE_SURROGATE_RE.sub("�", value)


def _plain(value: Any) -> str:
    """The Node package's plainText: '' for null or missing, JSON for objects, String() otherwise."""
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return _json_js(value)
    return _scalar_text(value)


def _parse_int(text: str) -> Any:
    # JSON.parse gives every number a double: integers past 2^53 are rounded as a double is.
    value = int(text)
    return value if abs(value) <= _MAX_SAFE_INTEGER else float(text)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def _parse_record(text: str) -> Tuple[Any, Optional[Exception]]:
    try:
        return json.loads(text, parse_int=_parse_int, parse_constant=_reject_constant), None
    except (ValueError, RecursionError) as e:
        return None, e


# --------------------------------------------------------------------------- timestamps

def _is_leap(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Days from 1970-01-01 to a proleptic Gregorian date (integer arithmetic, any 4-digit year)."""
    yy = year - 1 if month <= 2 else year
    era = yy // 400
    yoe = yy - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def timesketch_micros(ts: Any) -> str:
    """A UTC ISO 8601 time (the form the hook writes) as integer microseconds since the epoch, else ''.
    The date must exist (no 30 February, no hour 24, no leap second); years 0000-0099 stay as written."""
    m = _UTC_ISO_RE.fullmatch(ts) if isinstance(ts, str) else None
    if m is None:
        return ""
    year, month, day, hour, minute, second = (int(m.group(i)) for i in range(1, 7))
    if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59:
        return ""
    month_days = 29 if month == 2 and _is_leap(year) else _MONTH_DAYS[month - 1]
    if day < 1 or day > month_days:
        return ""
    secs = _days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second
    frac = int(m.group(7).ljust(6, "0")) if m.group(7) else 0
    return str(secs * 1000000 + frac)


# --------------------------------------------------------------------------- chain check and events

def _check_line(i: int, rec: Any, parse_error: Optional[Exception], expected_prev: str,
                total: int, is_cut_tail: bool, bad_reason: Optional[str]) -> Optional[Dict[str, Any]]:
    """The failure of line i, or None. Same checks, in the same order, as verify_evidence_ledger."""
    if bad_reason is not None:
        return _corrupt_result(total, i, f"Invalid UTF-8 bytes at line {i + 1}: the log was corrupted or modified.")
    if parse_error is not None:
        if is_cut_tail:
            return _truncated_tail_result(total, i)
        return {"valid": False, "total": total, "verified": i, "broken_index": i,
                "error": f"Malformed JSON at line {i + 1}: {parse_error}"}
    if not isinstance(rec, dict):
        return _corrupt_result(total, i, f"Malformed record at line {i + 1}: not a JSON object.")
    rec_prev = rec.get("prev_hash")
    if rec_prev != expected_prev:
        found = rec_prev[:8] if isinstance(rec_prev, str) else "undefined"
        return {"valid": False, "total": total, "verified": i, "broken_index": i,
                "error": f"Broken chain link at line {i + 1} (record {_template_text(rec, 'id')}): "
                         f"expected prev_hash {expected_prev[:8]}... but found {found}..."}
    recorded_hash = rec.get("record_hash")
    base = {k: v for k, v in rec.items() if k != "record_hash"}
    # Same as verify_evidence_ledger: a whole-number confidence is hashed as an integer.
    conf = base.get("confidence")
    if isinstance(conf, (int, float)) and float(conf).is_integer():
        base["confidence"] = int(conf)
    accepted = {
        hashlib.sha256(f"{expected_prev}:{t}".encode("utf-8", errors="replace")).hexdigest()
        for t in _canonical_forms(base)
    }
    if not isinstance(recorded_hash, str) or recorded_hash not in accepted:
        return {"valid": False, "total": total, "verified": i, "broken_index": i,
                "error": f"Tamper detected at line {i + 1} (record {_template_text(rec, 'id')}): "
                         "hash mismatch. The content of this log was altered!"}
    return None


def timesketch_csv_headers(include_preview: bool = False) -> List[str]:
    """The CSV header. include_preview adds zn_payload_preview just before zn_chain_index."""
    if not include_preview:
        return list(TIMESKETCH_CSV_HEADERS)
    return TIMESKETCH_CSV_HEADERS[:-2] + ["zn_payload_preview"] + TIMESKETCH_CSV_HEADERS[-2:]


def _template_text(rec: Dict[str, Any], key: str) -> str:
    """${rec[key]} in a JavaScript template: undefined when missing, null when null."""
    if key not in rec:
        return "undefined"
    if rec[key] is None:
        return "null"
    return _js_string(rec[key])


def _event(rec: Dict[str, Any], index: int, verified: bool, include_preview: bool = False) -> Dict[str, Any]:
    rule = _plain(rec.get("rule"))
    ev: Dict[str, Any] = {
        "message": f"{_plain(rec.get('verdict'))} {_plain(rec.get('tool_name'))} by "
                   f"{_plain(rec.get('agent_environment'))}" + (f" (rule {rule})" if rule else ""),
        "datetime": _plain(rec.get("timestamp")),
        "timestamp_desc": TIMESKETCH_DESC,
        "data_type": TIMESKETCH_DATA_TYPE,
    }
    for key, field in TIMESKETCH_RECORD_FIELDS:
        ev[key] = rec.get(field)
    # The preview is added only when the record has one (an empty preview is not written).
    preview = rec.get("payload_preview")
    if include_preview and preview is not None and preview != "":
        ev["zn_payload_preview"] = preview
    ev["zn_chain_index"] = index
    ev["zn_chain_verified"] = verified
    return ev


EVENT_FORMATS = ("timesketch", "timesketch-csv", "ocsf")
# OCSF schema version the ocsf format targets.
OCSF_VERSION = "1.7.0"
# Verdict -> (action_id, disposition_id, severity_id) of the OCSF Detection Finding. Other verdicts are Unknown (0).
_OCSF_VERDICTS = {"allow": (1, 1, 1), "block": (2, 2, 3)}


def ocsf_event(rec: Dict[str, Any], index: int, verified: bool, include_preview: bool = False) -> Dict[str, Any]:
    """The ocsf event for one record, same as the Node package's ocsfEvent. Class: Detection Finding (2004)
    in the Findings category (2), activity Create (1), so type_uid is 200401. A Detection Finding is the OCSF
    record of a policy decision on a detected action; the verdict goes to action_id and disposition_id
    (allowed or blocked). The zn_ fields go under unmapped, because OCSF has no field for them. A record whose
    timestamp is not a valid UTC time keeps its place: time is 0 and unmapped.zn_time_unmapped is true
    (zn_timestamp keeps the raw value)."""
    from . import __version__  # local import: keeps the package __init__ out of the import cycle
    ev = _event(rec, index, verified, include_preview)
    verdict = rec.get("verdict")
    action_id, disposition_id, severity_id = (
        _OCSF_VERDICTS.get(verdict, (0, 0, 0)) if isinstance(verdict, str) else (0, 0, 0)
    )
    micros = timesketch_micros(rec.get("timestamp"))
    unmapped = {k: v for k, v in ev.items() if k.startswith("zn_")}
    unmapped["zn_timestamp"] = rec.get("timestamp")
    if micros == "":
        time_ms = 0
        unmapped["zn_time_unmapped"] = True
    else:
        # Whole milliseconds, rounded down (also before 1970), as an integer.
        time_ms = int(micros) // 1000
    return {
        "activity_id": 1,
        "category_uid": 2,
        "category_name": "Findings",
        "class_uid": 2004,
        "class_name": "Detection Finding",
        "type_uid": 200401,
        "action_id": action_id,
        "disposition_id": disposition_id,
        "severity_id": severity_id,
        "time": time_ms,
        "message": ev["message"],
        "finding_info": {"uid": _plain(rec.get("id")), "title": ev["message"]},
        "metadata": {
            "version": OCSF_VERSION,
            "product": {"name": "zn-gate", "vendor_name": "zn", "version": __version__},
        },
        "cloud": {"provider": "local"},
        "osint": [],
        "unmapped": unmapped,
    }


def _event_line(fmt: str, rec: Dict[str, Any], index: int, verified: bool, include_preview: bool = False) -> str:
    if fmt == "ocsf":
        return _json_js(ocsf_event(rec, index, verified, include_preview))
    ev = _event(rec, index, verified, include_preview)
    if fmt == "timesketch":
        return _json_js(ev)
    cells = []
    for h in timesketch_csv_headers(include_preview):
        val = timesketch_micros(rec.get("timestamp")) if h == "timestamp" else _plain(ev.get(h))
        cells.append('"' + val.replace('"', '""') + '"')
    return ",".join(cells)


def inspect_ledger(file_path: str) -> Dict[str, Any]:
    """Checks the chain line by line, once, for the exports and the manifest. Returns valid, error,
    broken_index, truncated_tail, total (non-empty lines), tip_hash (the file's last record_hash),
    tip_record_hash (the last record that verified, or None), first_timestamp and last_timestamp
    (of the first and last line that is a JSON object), read_error, and rows: (index, record,
    verified) for every line that is a JSON object."""
    empty = {"valid": True, "error": None, "broken_index": None, "truncated_tail": False, "total": 0,
             "tip_hash": GENESIS_HASH, "tip_record_hash": None, "first_timestamp": None,
             "last_timestamp": None, "read_error": False, "rows": [], "parsed": []}
    if not os.path.exists(file_path):
        return empty
    try:
        lines, bad = _read_ledger(file_path)
    except EvidenceLedgerError as e:
        return {**empty, "valid": False, "error": str(e), "read_error": True}

    ends_with_newline = _ends_with_newline(file_path)
    total = len(lines)
    expected_prev = GENESIS_HASH
    failure: Optional[Dict[str, Any]] = None
    rows: List[Tuple[int, Dict[str, Any], bool]] = []
    parsed: List[Tuple[Any, bool]] = []
    first_ts: Optional[str] = None
    last_ts: Optional[str] = None
    for i, text in enumerate(lines):
        rec, parse_error = _parse_record(text)
        parsed.append((rec, parse_error is None))
        is_cut_tail = i == total - 1 and text.startswith(_RECORD_START) and not ends_with_newline
        if failure is None:
            failure = _check_line(i, rec, parse_error, expected_prev, total, is_cut_tail, bad.get(i))
            if failure is None:
                expected_prev = rec["record_hash"]
        if parse_error is None and isinstance(rec, dict):
            rows.append((i, rec, failure is None))
            ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None
            if len(rows) == 1:
                first_ts = ts
            last_ts = ts

    tip_hash = GENESIS_HASH
    if lines:
        last, last_error = _parse_record(lines[-1])
        if last_error is None and isinstance(last, dict) and last.get("record_hash"):
            tip_hash = last["record_hash"]
    return {
        "valid": failure is None,
        "error": None if failure is None else failure["error"],
        "broken_index": None if failure is None else failure["broken_index"],
        "truncated_tail": bool(failure and failure.get("truncated_tail")),
        "total": total,
        "tip_hash": tip_hash,
        "tip_record_hash": None if expected_prev == GENESIS_HASH else expected_prev,
        "first_timestamp": first_ts,
        "last_timestamp": last_ts,
        "read_error": False,
        "rows": rows,
        "parsed": parsed,
    }


def export_timesketch(file_path: str, fmt: str, include_preview: bool = False) -> Dict[str, Any]:
    """The whole Timesketch export as one string, with the chain check result (same fields as
    export_evidence_ledger). Lines that are not JSON objects give no event; a record after a
    break is written with zn_chain_verified false."""
    check = inspect_ledger(file_path)
    out: List[str] = []
    if fmt == "timesketch-csv":
        out.append(",".join(timesketch_csv_headers(include_preview)) + "\n")
    for i, rec, verified in check["rows"]:
        out.append(_event_line(fmt, rec, i, verified, include_preview) + "\n")
    result = {
        "content": "".join(out), "format": fmt, "tip_hash": check["tip_hash"], "total": check["total"],
        "valid": check["valid"], "error": check["error"],
    }
    if check["truncated_tail"]:
        result["truncated_tail"] = True
    if check["read_error"]:
        result["read_error"] = True
    return result


PLAIN_CSV_HEADERS = [
    "timestamp", "verdict", "phase", "tool_name", "agent_environment", "rule", "reason",
    "payload_sha256", "record_hash", "prev_hash", "latency_us",
]


def _js_string(value: Any) -> str:
    """String(value) for a value taken from JSON, as the csv row of the Node package writes it:
    null gives '', an object gives [object Object], and an array is joined with commas."""
    if value is None:
        return ""
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, list):
        return ",".join(_js_string(v) for v in value)
    return _scalar_text(value)


def _csv_row(rec: Any) -> str:
    """One csv row (csvRow in the Node package). A line that is not a JSON object gives empty cells."""
    cells = []
    for header in PLAIN_CSV_HEADERS:
        val = _js_string(rec.get(header)) if isinstance(rec, dict) else ""
        cells.append('"' + val.replace('"', '""') + '"')
    return ",".join(cells)


def _raw_jsonl(file_path: str, check: Dict[str, Any]) -> str:
    """The log as it is, decoded (undecodable bytes replaced), with a final newline. Line endings
    are kept, as the Node package keeps them."""
    if check["read_error"] or not os.path.exists(file_path):
        return ""
    with open(file_path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8", errors="replace")
    return text if raw.endswith(b"\n") else text + "\n"


def export_plain(file_path: str, fmt: str) -> Dict[str, Any]:
    """The jsonl or csv export, byte for byte what the Node package writes for the same log, with
    the chain check result. csv gives one row for every line that is a JSON value other than null."""
    check = inspect_ledger(file_path)
    if fmt == "csv":
        out = [",".join(PLAIN_CSV_HEADERS) + "\n"]
        for rec, ok in check["parsed"]:
            if ok and rec is not None:
                out.append(_csv_row(rec) + "\n")
        content = "".join(out)
    else:
        content = _raw_jsonl(file_path, check)
    result = {
        "content": content, "format": fmt, "valid": check["valid"], "error": check["error"],
        "tip_hash": check["tip_hash"], "total": check["total"],
    }
    if check["read_error"]:
        result["read_error"] = True
    return result


def sha256_file(file_path: str) -> str:
    """sha256 (hex) of a file, read in pieces."""
    digest = hashlib.sha256()
    with open(file_path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def manifest_text(*, fmt: str, source: str, check: Dict[str, Any], export_sha256: str, generator: str) -> str:
    """The manifest written next to an export (--manifest). Same bytes as the Node package for the
    same log; generator is the only field that may differ when the versions differ."""
    manifest = {
        "format": fmt,
        "source": source,
        "records": check["total"],
        "first_timestamp": check["first_timestamp"],
        "last_timestamp": check["last_timestamp"],
        "chain_verified": check["valid"] is True,
        "chain_break_index": None if check["valid"] else check["broken_index"],
        "tip_record_hash": check["tip_record_hash"],
        "export_sha256": export_sha256,
        "generator": generator,
    }
    return _json_js(manifest) + "\n"
