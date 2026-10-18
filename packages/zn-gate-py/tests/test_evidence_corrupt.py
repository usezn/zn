"""A ledger with invalid bytes or a broken line is reported as corrupted, never as a crash,
and never lets the next write silently restart the hash chain."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

import pytest

from zn_gate import cli, evidence
from zn_gate.evidence import (
    GENESIS_HASH,
    EvidenceLedgerError,
    export_evidence_ledger,
    get_evidence_stats,
    get_last_hash,
    log_evidence,
    verify_evidence_ledger,
)


@pytest.fixture(autouse=True)
def _reset_warning(monkeypatch):
    monkeypatch.setattr(evidence, "_last_warn", None)
    monkeypatch.setattr(evidence, "_last_write_warn", None)


def _ledger(tmp_path, n=2):
    p = str(tmp_path / "evidence.jsonl")
    for i in range(n):
        log_evidence({"payload": f"example-{i}", "tool_name": "bash"}, file_path=p)
    return p


def _append(p, data: bytes):
    with open(p, "ab") as f:
        f.write(data)


def _corrupt_end(tmp_path):
    p = _ledger(tmp_path)
    _append(p, b"\xff\xfe\x80garbage\n")
    return p, 3


def _corrupt_middle(tmp_path):
    p = _ledger(tmp_path, n=3)
    with open(p, "rb") as f:
        lines = f.read().split(b"\n")
    lines[1] = lines[1][:20] + b"\xff\xfe" + lines[1][20:]
    with open(p, "wb") as f:
        f.write(b"\n".join(lines))
    return p, 2


def _truncated_last(tmp_path):
    p = _ledger(tmp_path)
    with open(p, "rb") as f:
        data = f.read()
    with open(p, "wb") as f:
        f.write(data[: len(data) - 40])
    return p, 2


CORRUPT = [_corrupt_end, _corrupt_middle, _truncated_last]
# get_last_hash and log_evidence read only the end of the file: they refuse on damage to the
# last line. Damage earlier in the file is found by verify.
TAIL_CORRUPT = [_corrupt_end, _truncated_last]


def test_valid_log_still_verifies(tmp_path):
    p = _ledger(tmp_path, n=3)
    assert verify_evidence_ledger(p)["valid"] is True
    assert get_evidence_stats(p)["valid"] is True
    assert export_evidence_ledger(p)["valid"] is True
    assert len(get_last_hash(p)) == 64 and get_last_hash(p) != GENESIS_HASH


def test_empty_and_missing_file_are_genesis(tmp_path):
    missing = str(tmp_path / "nope.jsonl")
    assert get_last_hash(missing) == GENESIS_HASH
    empty = str(tmp_path / "empty.jsonl")
    open(empty, "wb").close()
    assert get_last_hash(empty) == GENESIS_HASH
    assert verify_evidence_ledger(empty)["valid"] is True
    rec = log_evidence({"payload": "x"}, file_path=empty)
    assert rec["prev_hash"] == GENESIS_HASH


@pytest.mark.parametrize("make", CORRUPT)
def test_verify_reports_corruption_with_line(tmp_path, make):
    p, line = make(tmp_path)
    res = verify_evidence_ledger(p)
    assert res["valid"] is False
    assert res["error"]
    assert f"line {line}" in res["error"]
    assert res["broken_index"] == line - 1


def test_invalid_bytes_message_names_the_bytes(tmp_path):
    p, line = _corrupt_end(tmp_path)
    assert "Invalid UTF-8" in verify_evidence_ledger(p)["error"]


@pytest.mark.parametrize("make", CORRUPT)
def test_stats_and_export_do_not_crash(tmp_path, make):
    p, _ = make(tmp_path)
    stats = get_evidence_stats(p)
    assert stats["valid"] is False and stats["error"]
    for fmt in ("jsonl", "csv"):
        res = export_evidence_ledger(p, fmt)
        assert res["valid"] is False and res["error"]
        assert isinstance(res["content"], str)


@pytest.mark.parametrize("make", TAIL_CORRUPT)
def test_get_last_hash_fails_closed(tmp_path, make):
    p, _ = make(tmp_path)
    with pytest.raises(EvidenceLedgerError):
        get_last_hash(p)


@pytest.mark.parametrize("make", TAIL_CORRUPT)
def test_log_evidence_refuses_to_append_and_warns_once(tmp_path, make, capsys):
    p, _ = make(tmp_path)
    before = open(p, "rb").read()
    assert log_evidence({"payload": "after"}, file_path=p) is None
    assert log_evidence({"payload": "again"}, file_path=p) is None
    assert open(p, "rb").read() == before  # nothing appended, chain not restarted
    err = capsys.readouterr().err
    assert err.count("is damaged") == 1
    assert "--verify" in err
    assert "evidence.damaged.jsonl" in err  # tells the user how to recover


def test_unreadable_log_fails_closed(tmp_path, monkeypatch, capsys):
    p = _ledger(tmp_path)
    real_open = open

    def fake_open(path, mode="r", *a, **k):
        if str(path) == p and "b" in mode and "r" in mode:
            raise PermissionError(13, "Permission denied")
        return real_open(path, mode, *a, **k)

    monkeypatch.setattr("builtins.open", fake_open)
    assert log_evidence({"payload": "x"}, file_path=p) is None
    assert verify_evidence_ledger(p)["valid"] is False
    assert "damaged" in capsys.readouterr().err


def test_cli_verify_reports_tamper_and_exits_nonzero(tmp_path, monkeypatch, capsys):
    p, _ = _corrupt_end(tmp_path)
    monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: verify_evidence_ledger(p))
    code = cli.cmd_evidence(type("A", (), {"verify": True})())
    assert code != 0
    assert "Tamper detected" in capsys.readouterr().err


def test_cli_stats_and_export_print_message_without_traceback(tmp_path, monkeypatch, capsys):
    p, _ = _corrupt_end(tmp_path)
    monkeypatch.setattr(cli, "get_evidence_stats", lambda: get_evidence_stats(p))
    monkeypatch.setattr(cli, "export_evidence_ledger", lambda format="jsonl": export_evidence_ledger(p, format))
    cli.cmd_evidence(type("A", (), {})())
    out = capsys.readouterr().out
    assert "CORRUPTED" in out and "Invalid UTF-8" in out
    cli.cmd_evidence(type("A", (), {"export": True, "format": "jsonl", "output": None})())
    assert "Tamper detected" in capsys.readouterr().err


def test_damage_in_the_middle_is_found_by_verify_and_not_hidden_by_appending(tmp_path):
    p, line = _corrupt_middle(tmp_path)
    assert log_evidence({"payload": "after"}, file_path=p) is not None
    res = verify_evidence_ledger(p)
    assert res["valid"] is False and f"line {line}" in res["error"]


def test_huge_damaged_last_line_still_fails_closed(tmp_path):
    p = _ledger(tmp_path)
    _append(p, b"x" * 300_000)  # longer than the tail window, no newline
    with pytest.raises(EvidenceLedgerError):
        get_last_hash(p)


def test_last_hash_of_a_long_valid_log_is_the_last_record(tmp_path):
    p = str(tmp_path / "long.jsonl")
    last = None
    for i in range(300):
        last = log_evidence({"payload": f"example-{i}"}, file_path=p)
    assert get_last_hash(p) == last["record_hash"]


def test_warning_repeats_after_the_interval(tmp_path, monkeypatch, capsys):
    p, _ = _corrupt_end(tmp_path)
    now = [1000.0]
    monkeypatch.setattr(evidence.time, "monotonic", lambda: now[0])
    log_evidence({"payload": "a"}, file_path=p)
    now[0] += evidence.WARN_INTERVAL - 1
    log_evidence({"payload": "b"}, file_path=p)
    assert capsys.readouterr().err.count("is damaged") == 1
    now[0] += 2
    log_evidence({"payload": "c"}, file_path=p)
    assert capsys.readouterr().err.count("is damaged") == 1


@pytest.mark.parametrize("junk", [b"\xef\xbb\xbf", b"\xc2\xa0"], ids=["bom", "nbsp"])
@pytest.mark.parametrize("where", ["start", "end"])
def test_bom_and_nbsp_are_not_trimmed(tmp_path, junk, where):
    # Same result as the Node package: only space, tab and CR are trimmed around a line.
    p = _ledger(tmp_path)
    with open(p, "rb") as f:
        data = f.read()
    lines = data.split(b"\n")
    lines[0] = junk + lines[0] if where == "start" else lines[0] + junk
    with open(p, "wb") as f:
        f.write(b"\n".join(lines))
    res = verify_evidence_ledger(p)
    assert res["valid"] is False and "line 1" in res["error"]


def test_crlf_and_padding_with_ascii_whitespace_stay_valid(tmp_path):
    p = _ledger(tmp_path)
    with open(p, "rb") as f:
        data = f.read()
    with open(p, "wb") as f:
        f.write(data.replace(b"\n", b" \t\r\n"))
    assert verify_evidence_ledger(p)["valid"] is True
    assert len(get_last_hash(p)) == 64


def test_recovery_hint_names_the_move_and_the_cli_prints_it(tmp_path, monkeypatch, capsys):
    p, _ = _corrupt_end(tmp_path)
    assert "evidence.damaged.jsonl" in evidence.recovery_hint(p)
    monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: verify_evidence_ledger(p))
    monkeypatch.setattr(cli, "recovery_hint", lambda: evidence.recovery_hint(p))
    cli.cmd_evidence(type("A", (), {"verify": True})())
    assert "evidence.damaged.jsonl" in capsys.readouterr().err


# ---- record_hash must be 64 lowercase hex characters ----

@pytest.mark.parametrize("bad", ["z" * 64, "A" * 64, "a" * 63 + " ", "a" * 63 + "\n"])
def test_last_record_hash_must_be_lowercase_hex(tmp_path, capsys, bad):
    p = str(tmp_path / "evidence.jsonl")
    with open(p, "w", encoding="utf-8") as f:
        f.write(json.dumps({"id": "x", "prev_hash": GENESIS_HASH, "record_hash": bad}) + "\n")
    with pytest.raises(EvidenceLedgerError):
        get_last_hash(p)
    before = open(p, "rb").read()
    assert log_evidence({"payload": "after"}, file_path=p) is None
    assert "is damaged" in capsys.readouterr().err
    assert open(p, "rb").read() == before


# ---- a log that cannot be written never breaks the caller ----

_posix_user = pytest.mark.skipif(
    os.name != "posix" or (hasattr(os, "getuid") and os.getuid() == 0),
    reason="needs POSIX permissions and a non-root user",
)


@_posix_user
def test_log_readable_but_not_writable_warns_and_does_not_raise(tmp_path, capsys):
    p = _ledger(tmp_path)
    os.chmod(p, 0o400)
    try:
        before = open(p, "rb").read()
        assert log_evidence({"payload": "after"}, file_path=p) is None
        assert log_evidence({"payload": "again"}, file_path=p) is None
        err = capsys.readouterr().err
        assert err.count("cannot write to the evidence log") == 1  # warns once
        assert open(p, "rb").read() == before
        assert verify_evidence_ledger(p)["valid"] is True
        assert not os.path.exists(p + ".lock")
    finally:
        os.chmod(p, 0o600)


@_posix_user
def test_directory_not_writable_warns_and_does_not_raise(tmp_path, capsys):
    sub = tmp_path / "ro"
    sub.mkdir(mode=0o500)
    try:
        assert log_evidence({"payload": "x"}, file_path=str(sub / "evidence.jsonl")) is None
        assert "cannot write to the evidence log" in capsys.readouterr().err
    finally:
        os.chmod(sub, 0o700)


# ---- the write lock ----

def test_busy_lock_skips_the_write_after_a_short_wait(tmp_path, capsys):
    p = _ledger(tmp_path, n=1)
    assert not os.path.exists(p + ".lock")  # released after a normal write
    with open(p + ".lock", "w") as f:
        f.write("99999")
    before = open(p, "rb").read()
    t0 = time.monotonic()
    assert log_evidence({"payload": "blocked"}, file_path=p) is None
    waited = time.monotonic() - t0
    assert 1.5 <= waited < 8, waited
    assert "another process is writing" in capsys.readouterr().err
    assert open(p, "rb").read() == before
    assert os.path.exists(p + ".lock")  # a lock held by someone else is left alone


def test_stale_lock_is_removed(tmp_path):
    p = _ledger(tmp_path, n=1)
    with open(p + ".lock", "w") as f:
        f.write("99999")
    old = time.time() - 60
    os.utime(p + ".lock", (old, old))
    assert log_evidence({"payload": "after the crash"}, file_path=p)
    assert not os.path.exists(p + ".lock")
    v = verify_evidence_ledger(p)
    assert v["valid"] is True and v["total"] == 2


_SRC = os.path.join(os.path.dirname(os.path.abspath(evidence.__file__)), "..")
_EVIDENCE_JS = os.path.normpath(os.path.join(_SRC, "..", "..", "zn-gate", "lib", "evidence.js"))
_NODE = shutil.which("node")
_has_node_pkg = os.path.exists(_EVIDENCE_JS)

_PY_WRITER = (
    "import sys\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from zn_gate.evidence import log_evidence\n"
    "file, wid, n = sys.argv[2], sys.argv[3], int(sys.argv[4])\n"
    "for i in range(n):\n"
    "    if log_evidence({'payload': 'py-%s-%d' % (wid, i), 'tool_name': 'bash'}, file_path=file) is None:\n"
    "        sys.exit(3)\n"
)
_NODE_WRITER = (
    "const { logEvidence } = require(process.argv[1]);\n"
    "const [, , file, id, n] = process.argv;\n"
    "for (let i = 0; i < Number(n); i++) {\n"
    "  if (!logEvidence({ payload: 'node-' + id + '-' + i, tool_name: 'bash' }, file)) process.exit(3);\n"
    "}\n"
)


def _wait_all(procs):
    for p in procs:
        _out, err = p.communicate(timeout=120)
        assert p.returncode == 0, err.decode("utf-8", "replace")


def _spawn_py(file, wid, n):
    return subprocess.Popen(
        [sys.executable, "-c", _PY_WRITER, os.path.normpath(_SRC), file, str(wid), str(n)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def test_concurrent_writers_keep_one_chain(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    n_procs, per = 6, 40
    _wait_all([_spawn_py(p, i, per) for i in range(n_procs)])
    v = verify_evidence_ledger(p)
    assert v["error"] is None
    assert v["valid"] is True
    assert v["total"] == n_procs * per
    assert not os.path.exists(p + ".lock")


@pytest.mark.skipif(not (_NODE and _has_node_pkg), reason="needs node and the Node package in the repo")
def test_python_and_node_writers_at_the_same_time_share_one_chain(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    per = 40
    procs = []
    for i in range(3):
        procs.append(_spawn_py(p, i, per))
        procs.append(subprocess.Popen(
            [_NODE, "-e", _NODE_WRITER, _EVIDENCE_JS, p, str(i), str(per)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ))
    _wait_all(procs)
    v = verify_evidence_ledger(p)
    assert v["error"] is None
    assert v["valid"] is True
    assert v["total"] == 6 * per


# ---- one canonical form for non-ASCII text, shared with Node ----

NON_ASCII = "café ñandú 漢字 \U0001F600 end"


def _node_verify(p):
    code = "const { verifyEvidenceLedger } = require(process.argv[1]); console.log(JSON.stringify(verifyEvidenceLedger(process.argv[2])));"
    r = subprocess.run([_NODE, "-e", code, _EVIDENCE_JS, p], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.mark.skipif(not (_NODE and _has_node_pkg), reason="needs node and the Node package in the repo")
def test_non_ascii_records_written_by_python_verify_in_node(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    for _ in range(3):
        assert log_evidence({"payload": NON_ASCII, "reason": NON_ASCII, "tool_name": "bash"}, file_path=p)
    assert "漢字" in open(p, encoding="utf-8").read()  # written as text, not as \uXXXX
    assert verify_evidence_ledger(p)["valid"] is True
    v = _node_verify(p)
    assert v["valid"] is True, v
    assert v["total"] == 3


@pytest.mark.skipif(not (_NODE and _has_node_pkg), reason="needs node and the Node package in the repo")
def test_non_ascii_records_written_by_node_verify_in_python(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    code = ("const { logEvidence } = require(process.argv[1]);"
            "for (let i = 0; i < 3; i++) { if (!logEvidence({ payload: process.argv[3], reason: process.argv[3], tool_name: 'bash' }, process.argv[2])) process.exit(3); }")
    r = subprocess.run([_NODE, "-e", code, _EVIDENCE_JS, p, NON_ASCII], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    v = verify_evidence_ledger(p)
    assert v["error"] is None
    assert v["valid"] is True
    assert v["total"] == 3
    assert get_last_hash(p) == json.loads(open(p, encoding="utf-8").read().splitlines()[-1])["record_hash"]


def test_log_written_by_older_version_with_escaped_non_ascii_still_verifies(tmp_path):
    """Earlier versions hashed the \\uXXXX-escaped form. Those logs must keep verifying and can be extended."""
    p = str(tmp_path / "old.jsonl")
    prev = GENESIS_HASH
    for i in range(2):
        base = {"id": f"ev_old_{i}", "timestamp": "2026-01-01T00:00:00+00:00", "agent_environment": "python-agent",
                "phase": "tool-call", "tool_name": "bash", "payload_sha256": "a" * 64, "payload_preview": NON_ASCII,
                "verdict": "allow", "rule": None, "reason": None, "confidence": 1, "latency_us": 0,
                "engine": "python-deterministic", "prev_hash": prev}
        escaped = json.dumps(base, separators=(",", ":"))  # the old form: ensure_ascii=True
        assert "\\u6f22" in escaped
        h = hashlib.sha256(f"{prev}:{escaped}".encode("utf-8")).hexdigest()
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps({**base, "record_hash": h}, separators=(",", ":")) + "\n")
        prev = h
    assert verify_evidence_ledger(p)["valid"] is True
    assert log_evidence({"payload": NON_ASCII}, file_path=p)
    v = verify_evidence_ledger(p)
    assert v["valid"] is True and v["total"] == 3
    with open(p, "r", encoding="utf-8") as f:
        text = f.read()
    with open(p, "w", encoding="utf-8") as f:
        f.write(text.replace("ev_old_0", "ev_old_X"))
    assert verify_evidence_ledger(p)["valid"] is False


def test_lone_surrogate_is_escaped_like_node(tmp_path):
    """JSON.stringify writes a lone surrogate as \\udXXX; so does the Python canonical form."""
    assert evidence._canonical({"a": "x\ud800y"}) == '{"a":"x\\ud800y"}'
    assert evidence._canonical({"a": "\U0001F600"}) == '{"a":"\U0001F600"}'
    p = str(tmp_path / "evidence.jsonl")
    assert log_evidence({"payload": "x\ud800y", "tool_name": "bash"}, file_path=p)  # does not raise
    assert verify_evidence_ledger(p)["valid"] is True


# ---- lock ownership and edge cases ----

def test_writer_that_lost_its_lock_writes_nothing_and_leaves_the_new_lock_alone(tmp_path, capsys, monkeypatch):
    p = _ledger(tmp_path, n=1)
    before = open(p, "rb").read()
    real = evidence.get_last_hash

    def steal_after_reading(path):
        h = real(path)
        # Simulates a stalled writer: someone else broke its lock and took it.
        with open(path + ".lock", "w") as f:
            f.write("4242:otherwriter")
        return h

    monkeypatch.setattr(evidence, "get_last_hash", steal_after_reading)
    assert log_evidence({"payload": "slow writer"}, file_path=p) is None
    assert "taken over" in capsys.readouterr().err
    assert open(p, "rb").read() == before
    assert open(p + ".lock").read() == "4242:otherwriter"


def test_several_writers_meeting_one_stale_lock_keep_one_chain(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    with open(p + ".lock", "w") as f:
        f.write("1:crashed")
    old = time.time() - 60
    os.utime(p + ".lock", (old, old))
    _wait_all([_spawn_py(p, i, 5) for i in range(6)])
    v = verify_evidence_ledger(p)
    assert v["error"] is None and v["valid"] is True and v["total"] == 30
    assert [n for n in os.listdir(tmp_path) if ".lock" in n] == []


def test_lock_dated_in_the_future_counts_as_stale(tmp_path):
    p = _ledger(tmp_path, n=1)
    with open(p + ".lock", "w") as f:
        f.write("1:crashed")
    future = time.time() + 3600
    os.utime(p + ".lock", (future, future))
    assert log_evidence({"payload": "after clock change"}, file_path=p)
    assert verify_evidence_ledger(p)["total"] == 2


@pytest.mark.skipif(os.name != "posix", reason="needs symlinks")
def test_unreadable_lock_path_does_not_spin_the_cpu(tmp_path, capsys):
    p = _ledger(tmp_path, n=1)
    os.symlink(str(tmp_path / "missing-target"), p + ".lock")
    cpu0 = time.process_time()
    assert log_evidence({"payload": "x"}, file_path=p, lock_wait=0.6) is None
    assert time.process_time() - cpu0 < 0.4
