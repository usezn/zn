"""The export's chain check (inspect_ledger) and verify_evidence_ledger give the same verdict.

The export checks the chain while it streams the records, so it has its own line-by-line check
(_check_line) that also keeps going past the first failure to mark each record. Its messages are the
export's own wording, so it cannot simply call verify_evidence_ledger. This test keeps the two in step:
every tamper case below, at every record position, must give the same valid flag, the same broken line,
the same kind of failure and the same cut-off-tail flag from both. The cases follow the tamper matrix
of the evidence chain audit (edit, flip hashes, add or remove a field, swap, duplicate, delete, cut,
garbage, invalid UTF-8, BOM, format-only respellings, truncation).
"""
import json
import re

from zn_gate.evidence import log_evidence, verify_evidence_ledger
from zn_gate.evidence_timesketch import inspect_ledger

N = 6
NL = b"\n"
KINDS = ("Invalid UTF-8", "Malformed JSON", "Malformed record", "Broken chain link", "Tamper detected",
         "Last record is incomplete")


def _kind(error):
    if error is None:
        return None
    for k in KINDS:
        if error.startswith(k):
            return k
    return "other: " + error


def _line_no(error):
    m = re.search(r"at line (\d+)", error or "")
    return int(m.group(1)) if m else None


def _base(tmp_path):
    p = str(tmp_path / "base.jsonl")
    for i in range(N):
        log_evidence({"payload": f"example-{i}", "tool_name": "bash"}, file_path=p)
    with open(p, "rb") as f:
        return f.read().split(NL)[:-1]  # N lines


def _edit(line, fn):
    rec = json.loads(line)
    fn(rec)
    return json.dumps(rec, separators=(",", ":")).encode("utf-8")


def _flip(h):
    return ("0" if h[0] != "0" else "1") + h[1:]


def _file(lines, tail=NL):
    return NL.join(lines) + tail


def _edit_cases(lines, p):
    fns = {
        "edit verdict": lambda r: r.__setitem__("verdict", "allow" if r.get("verdict") != "allow" else "block"),
        "flip record_hash": lambda r: r.__setitem__("record_hash", _flip(r["record_hash"])),
        "flip prev_hash": lambda r: r.__setitem__("prev_hash", _flip(r["prev_hash"])),
        "add field": lambda r: r.__setitem__("extra_field", 1),
        "remove field": lambda r: r.pop("tool_name", None),
        "latency as float": lambda r: r.__setitem__("latency_us", float(r.get("latency_us", 5))),
        "confidence as float": lambda r: r.__setitem__("confidence", float(r.get("confidence", 1))),
    }
    for name, fn in fns.items():
        ls = list(lines)
        ls[p] = _edit(ls[p], fn)
        yield f"{name}@{p}", _file(ls)


def _structure_cases(lines, p):
    ls = list(lines)
    del ls[p]
    yield f"delete@{p}", _file(ls)
    for name, extra in (("duplicate", None), ("blank line", b""), ("not an object", b"[1,2]"),
                        ("garbage line", b"garbage")):
        ls = list(lines)
        ls.insert(p + 1 if extra is None else p, lines[p] if extra is None else extra)
        yield f"{name}@{p}", _file(ls)
    ls = list(lines)
    ls[p] = ls[p].replace(b"example", b"exa\xff\xfemple")
    yield f"invalid utf-8@{p}", _file(ls)
    ls = list(lines)
    ls[p] = ls[p] + b" "
    yield f"trailing space@{p}", _file(ls)
    yield f"CRLF@{p}", _file([x + (b"\r" if i == p else b"") for i, x in enumerate(lines)])
    yield f"truncate to {p} records", _file(lines[:p]) if p else b""
    for cut in (1, 40, len(lines[p]) - 1):
        yield f"cut inside line {p} by {cut}", _file(lines[:p] + [lines[p][:len(lines[p]) - cut]], b"")
    if p + 1 < len(lines):
        ls = list(lines)
        ls[p], ls[p + 1] = ls[p + 1], ls[p]
        yield f"swap@{p}", _file(ls)


def _cases(lines):
    out = [("clean", _file(lines)), ("empty", b""), ("no trailing newline", _file(lines, b"")),
           ("BOM", b"\xef\xbb\xbf" + _file(lines))]
    for p in range(len(lines)):
        out.extend(_edit_cases(lines, p))
        out.extend(_structure_cases(lines, p))
    return out


def test_export_check_and_verify_agree_on_the_tamper_corpus(tmp_path):
    cases = _cases(_base(tmp_path))
    assert len(cases) > 100
    disagreements = []
    for name, data in cases:
        p = tmp_path / "case.jsonl"
        p.write_bytes(data)
        v = verify_evidence_ledger(str(p))
        c = inspect_ledger(str(p))
        got = (c["valid"], c["broken_index"], _kind(c["error"]), _line_no(c["error"]), bool(c["truncated_tail"]))
        want = (v["valid"], v["broken_index"], _kind(v["error"]), _line_no(v["error"]), bool(v.get("truncated_tail")))
        if got != want:
            disagreements.append((name, want, got))
    assert disagreements == []


def test_a_missing_log_is_valid_and_empty_in_both(tmp_path):
    p = str(tmp_path / "none.jsonl")
    v = verify_evidence_ledger(p)
    c = inspect_ledger(p)
    assert v["valid"] is True and c["valid"] is True and c["total"] == 0 == v["total"]
