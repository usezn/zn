"""`evidence --verify`, stats and export read the log once, line by line.

The results and messages are the same as the versions that read the whole file into memory
(evidence_reference_impl.py), and the memory they use does not grow with the size of the log.

The memory test is opt-in because it writes about 1 GB:
    ZN_SLOW_TESTS=1 python -m pytest tests/test_evidence_streaming_read.py -k memory
ZN_SLOW_LEDGER_MB changes the size (default 1024). It needs Linux and /usr/bin/time.
"""
import hashlib
import io
import json
import os
import subprocess
import sys

import pytest

from zn_gate import evidence as ev
from zn_gate.evidence import GENESIS_HASH, _canonical, get_evidence_stats, verify_evidence_ledger

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evidence_reference_impl as ref  # noqa: E402


def make_lines(n):
    prev = GENESIS_HASH
    out = []
    for i in range(n):
        base = {
            "id": "ev_%x_%08x" % (1700000000000 + i, i),
            "timestamp": "2026-11-18T10:00:00.000000+00:00",
            "agent_environment": "test",
            "phase": "tool-call",
            "tool_name": "tool%d" % ((i * 7) % 5),
            "payload_sha256": hashlib.sha256(str(i).encode()).hexdigest(),
            "payload_preview": "payload %d é 漢" % i,
            "verdict": "block" if i % 4 == 0 else ("shadow" if i % 9 == 0 else "allow"),
            "rule": ("RULE_%d" % ((i * 3) % 4)) if i % 4 == 0 else None,
            "reason": 'said "no", line %d' % i,
            "confidence": 1,
            "latency_us": i,
            "engine": "test",
            "prev_hash": prev,
        }
        h = hashlib.sha256(("%s:%s" % (prev, _canonical(base))).encode("utf-8")).hexdigest()
        rec = dict(base)
        rec["record_hash"] = h
        out.append(json.dumps(rec, separators=(",", ":"), ensure_ascii=False))
        prev = h
    return out


def write(path, lines, newline=b"\n", end=True):
    data = newline.join(l.encode("utf-8") for l in lines)
    path.write_bytes(data + (newline if end else b""))
    return str(path)


def variants(tmp_path):
    """Name -> path of a ledger of every shape the readers must agree on."""
    good = make_lines(14)
    out = {}

    def add(name, lines, **kw):
        out[name] = write(tmp_path / (name + ".jsonl"), lines, **kw)

    add("valid", good)
    add("valid_no_final_newline", good, end=False)
    add("crlf", good, newline=b"\r\n")
    add("blank_lines", good[:5] + ["", "  \t "] + good[5:])
    add("tampered", good[:6] + [good[6].replace("payload", "pAyload")] + good[7:])
    add("broken_link", good[:3] + good[4:])
    add("malformed_middle", good[:8] + ['{"id":'] + good[9:])
    add("not_an_object", good[:2] + ["[1,2]"] + good[3:])
    add("not_json_value", good[:2] + ["42"] + good[3:])
    add("truncated_tail", good[:-1] + [good[-1][:-60]], end=False)
    add("truncated_tail_with_newline", good[:-1] + [good[-1][:-60]])
    add("junk_tail", good + ["hello"], end=False)
    add("single", good[:1])
    out["empty"] = str(tmp_path / "empty.jsonl")
    (tmp_path / "empty.jsonl").write_bytes(b"")
    out["whitespace_only"] = str(tmp_path / "ws.jsonl")
    (tmp_path / "ws.jsonl").write_bytes(b" \n\t\r\n\n")
    raw = ("\n".join(good[:4]) + "\n").encode("utf-8") + b"\xff\xfe\n" + ("\n".join(good[4:]) + "\n").encode("utf-8")
    out["bad_utf8"] = str(tmp_path / "bad.jsonl")
    (tmp_path / "bad.jsonl").write_bytes(raw)
    out["bom"] = str(tmp_path / "bom.jsonl")
    (tmp_path / "bom.jsonl").write_bytes(b"\xef\xbb\xbf" + ("\n".join(good) + "\n").encode("utf-8"))
    out["missing"] = str(tmp_path / "missing.jsonl")
    out["a_folder"] = str(tmp_path)
    return out


def test_verify_matches_the_whole_file_version(tmp_path):
    for name, path in variants(tmp_path).items():
        assert verify_evidence_ledger(path) == ref.ref_verify(path), name


@pytest.mark.parametrize("limit", [50, 7, 1, 0])
def test_stats_match_the_whole_file_version(tmp_path, limit):
    for name, path in variants(tmp_path).items():
        got = get_evidence_stats(path, limit)
        want = ref.ref_stats(path, limit)
        assert got == want, name
        # Same order, not only the same contents.
        assert list(got["top_rules"]) == list(want["top_rules"]), name
        assert list(got["top_tools"]) == list(want["top_tools"]), name


def test_export_matches_the_whole_file_version(tmp_path):
    for name, path in variants(tmp_path).items():
        for fmt in ("jsonl", "csv"):
            got = ev.export_evidence_ledger(path, fmt)
            want = ref.ref_export(path, fmt)
            if name == "a_folder":
                # A log that cannot be read exports nothing and is not valid; the reason is now given.
                assert got["valid"] is False and want["valid"] is False
                assert got["total"] == want["total"] == 0
                continue
            assert got == want, (name, fmt)


def test_streamed_export_equals_the_returned_export(tmp_path):
    for name, path in variants(tmp_path).items():
        if name == "a_folder":
            continue
        for fmt in ("jsonl", "csv"):
            out = io.StringIO()
            res = ev.write_evidence_export(path, fmt, out)
            want = ev.export_evidence_ledger(path, fmt)
            assert out.getvalue() == want["content"], (name, fmt)
            assert res["valid"] == want["valid"] and res["total"] == want["total"]
            assert res["tip_hash"] == want["tip_hash"]


def test_a_truncated_last_line_is_cut_off_not_tampering(tmp_path):
    path = variants(tmp_path)["truncated_tail"]
    r = verify_evidence_ledger(path)
    assert r["valid"] is False
    assert r["truncated_tail"] is True
    assert (r["total"], r["verified"], r["broken_index"]) == (14, 13, 13)
    assert r["error"].startswith("Last record is incomplete")
    assert r["error"].endswith("at line 14: the line is not valid JSON.")
    s = get_evidence_stats(path)
    assert s["valid"] is False and s["total"] == 14 and len(s["recent"]) == 13
    # The same cut followed by a newline is a tamper report.
    r2 = verify_evidence_ledger(variants(tmp_path)["truncated_tail_with_newline"])
    assert "truncated_tail" not in r2
    assert r2["error"].startswith("Malformed JSON at line 14: ")


def test_the_log_is_opened_once_per_command(tmp_path, monkeypatch):
    path = variants(tmp_path)["valid"]
    real_open = open
    opens = []

    def counting_open(p, *a, **k):
        if os.fspath(p) == path:
            opens.append(a[:1])
        return real_open(p, *a, **k)

    monkeypatch.setattr("builtins.open", counting_open)
    for fn in (verify_evidence_ledger, get_evidence_stats, ev.export_evidence_ledger):
        del opens[:]
        assert fn(path)["valid"] is True
        assert len(opens) == 1, fn.__name__


def test_a_log_is_read_one_line_at_a_time(tmp_path, monkeypatch):
    """No call reads the whole file: reading everything at once would call read() with no limit."""
    path = variants(tmp_path)["valid"]
    real_open = open
    calls = []

    class Spy:
        def __init__(self, f):
            self._f = f

        def read(self, *a):
            calls.append(("read", a))
            return self._f.read(*a)

        def readlines(self, *a):
            calls.append(("readlines", a))
            return self._f.readlines(*a)

        def __getattr__(self, name):
            return getattr(self._f, name)

        def __iter__(self):
            return iter(self._f)

        def __enter__(self):
            self._f.__enter__()
            return self

        def __exit__(self, *a):
            return self._f.__exit__(*a)

    def spy_open(p, *a, **k):
        f = real_open(p, *a, **k)
        return Spy(f) if os.fspath(p) == path and "rb" in a[:1] else f

    monkeypatch.setattr("builtins.open", spy_open)
    verify_evidence_ledger(path)
    get_evidence_stats(path)
    ev.export_evidence_ledger(path, "csv")
    # _is_cut_tail reads one byte, only for a malformed last line; nothing here reads everything.
    assert [c for c in calls if c[0] == "readlines" or (c[0] == "read" and not c[1])] == []


# ---- opt-in memory test ------------------------------------------------------------------------

SLOW = os.environ.get("ZN_SLOW_TESTS") == "1"
HAS_TIME = sys.platform.startswith("linux") and os.path.exists("/usr/bin/time")


def write_big_ledger(path, nbytes):
    prev = GENESIS_HASH
    size = 0
    i = 0
    pad = "x" * 600
    with open(path, "wb") as f:
        batch = []
        while size < nbytes:
            base = {
                "id": "ev_%x_%08x" % (1700000000000 + i, i),
                "timestamp": "2026-11-18T10:00:00.000000+00:00",
                "agent_environment": "synthetic",
                "phase": "tool-call",
                "tool_name": "tool%d" % (i % 7),
                "payload_sha256": hashlib.sha256(str(i).encode()).hexdigest(),
                "payload_preview": "payload %d" % i,
                "verdict": "block" if i % 3 == 0 else ("shadow" if i % 11 == 0 else "allow"),
                "rule": ("RULE_%d" % (i % 5)) if i % 3 == 0 else None,
                "reason": pad,
                "confidence": 1,
                "latency_us": i % 1000,
                "engine": "synthetic",
                "prev_hash": prev,
            }
            h = hashlib.sha256(("%s:%s" % (prev, _canonical(base))).encode()).hexdigest()
            rec = dict(base)
            rec["record_hash"] = h
            line = json.dumps(rec, separators=(",", ":")) + "\n"
            batch.append(line.encode())
            size += len(line)
            prev = h
            i += 1
            if len(batch) >= 1000:
                f.write(b"".join(batch))
                batch = []
        f.write(b"".join(batch))
    return i


@pytest.mark.skipif(not SLOW or not HAS_TIME, reason="opt-in: ZN_SLOW_TESTS=1 on Linux with /usr/bin/time")
def test_memory_stays_under_200_mb_on_a_1_gb_log(tmp_path):
    home = tmp_path / "home"
    (home / ".zn").mkdir(parents=True)
    mb = int(os.environ.get("ZN_SLOW_LEDGER_MB", "1024"))
    limit = float(os.environ.get("ZN_SLOW_LIMIT_MB", "200"))
    records = write_big_ledger(str(home / ".zn" / "evidence.jsonl"), mb * 1024 * 1024)
    env = dict(os.environ, ZN_HOME=str(home / ".zn"), ZN_STATS="off", NO_COLOR="1")
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
    env["PYTHONPATH"] = src + os.pathsep + env.get("PYTHONPATH", "")
    for name, args, expect in [
        ("verify", ["--verify"], "ALL %d RECORDS VERIFIED" % records),
        ("stats", [], "Total Events   : %d" % records),
        ("export jsonl", ["--export"], '{"id":"ev_'),
        ("export csv", ["--export", "--format", "csv"], "timestamp,verdict"),
    ]:
        out_path = tmp_path / "out.txt"
        time_path = tmp_path / "time.txt"
        with open(out_path, "wb") as out:
            r = subprocess.run(["/usr/bin/time", "-v", "-o", str(time_path), sys.executable, "-m", "zn_gate", "evidence"] + args,
                               env=env, stdout=out, stderr=subprocess.PIPE)
        assert r.returncode == 0, (name, r.stderr[-300:])
        with open(out_path, "rb") as f:
            assert expect in f.read(4000).decode("utf-8", "replace"), name
        peak_kb = int([l for l in time_path.read_text().splitlines() if "Maximum resident" in l][0].split()[-1])
        print("%s: peak %.0f MB" % (name, peak_kb / 1024))
        assert peak_kb / 1024 < limit, "%s used %.0f MB, limit %.0f" % (name, peak_kb / 1024, limit)
