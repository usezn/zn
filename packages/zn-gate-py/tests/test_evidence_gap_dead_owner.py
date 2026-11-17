"""A lock whose owner process is gone is broken at once (same machine); a live owner is still waited
for. A write dropped because the lock stayed busy is counted, and the next write says so in the log.
The Node package does the same with the same files, so each package reads what the other wrote."""
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from zn_gate import evidence

NODE = shutil.which("node")
NODE_EVIDENCE = Path(__file__).resolve().parents[2] / "zn-gate" / "lib" / "evidence.js"
needs_node = pytest.mark.skipif(NODE is None or not NODE_EVIDENCE.is_file(), reason="Node package not available")
posix_only = pytest.mark.skipif(os.name != "posix", reason="the dead-owner check is not made on Windows")

EVENT = {"agent": "a", "tool_name": "t", "verdict": "block", "rule": "R", "payload": "x", "phase": "p"}


@pytest.fixture(autouse=True)
def _clean_hooks(monkeypatch):
    monkeypatch.setattr(evidence, "_test_hooks", {})


def _dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def _token(pid: int, host: str = "") -> str:
    return f"{pid}:{secrets.token_hex(8)}:{host or evidence._host_tag()}"


def _lines(ledger):
    return [json.loads(x) for x in Path(ledger).read_text(encoding="utf-8").splitlines() if x]


@posix_only
def test_lock_with_a_dead_owner_is_broken_at_once(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    Path(lock).write_text(_token(_dead_pid()), encoding="ascii")
    started = time.monotonic()
    token = evidence._acquire_lock(lock, wait=5.0)
    assert time.monotonic() - started < 1.5  # not the 10 s stale window
    assert evidence._owns_lock(lock, token)
    assert not os.path.exists(lock + ".break")
    evidence._release_lock(lock, token)
    assert not os.path.exists(lock)


@posix_only
def test_lock_with_a_live_owner_is_still_waited_for(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        Path(lock).write_text(_token(child.pid), encoding="ascii")
        with pytest.raises(evidence.EvidenceLockError):
            evidence._acquire_lock(lock, wait=0.2)
        assert os.path.exists(lock)
    finally:
        child.kill()
        child.wait()


@posix_only
def test_doubt_keeps_the_wait(tmp_path, monkeypatch):
    lock = str(tmp_path / "evidence.jsonl.lock")
    dead = _dead_pid()
    Path(lock).write_text(_token(dead), encoding="ascii")
    assert evidence._dead_owner_token(lock)  # control

    def eperm(pid, sig):
        raise PermissionError(1, "denied")

    with monkeypatch.context() as m:
        m.setattr(evidence.os, "kill", eperm)
        assert evidence._dead_owner_token(lock) is None  # alive but not ours
    other = "0" * 8 if evidence._host_tag() != "0" * 8 else "f" * 8
    Path(lock).write_text(_token(dead, other), encoding="ascii")
    assert evidence._dead_owner_token(lock) is None  # another machine
    Path(lock).write_text(f"{dead}:abc", encoding="ascii")
    assert evidence._dead_owner_token(lock) is None  # an older token has no machine part
    Path(lock).write_text(_token(os.getpid()), encoding="ascii")
    assert evidence._dead_owner_token(lock) is None
    Path(lock).write_text("", encoding="ascii")
    assert evidence._dead_owner_token(lock) is None


def test_no_dead_owner_check_on_windows(tmp_path, monkeypatch):
    lock = str(tmp_path / "evidence.jsonl.lock")
    Path(lock).write_text(_token(_dead_pid()), encoding="ascii")
    monkeypatch.setattr(evidence.os, "name", "nt")
    assert evidence._dead_owner_token(lock) is None  # os.kill(pid, 0) would end a process there


@posix_only
def test_dropped_writes_are_counted_and_the_next_write_adds_a_gap_record(tmp_path, capsys):
    ledger = str(tmp_path / "evidence.jsonl")
    assert evidence.log_evidence(EVENT, ledger)
    lock = ledger + ".lock"
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        Path(lock).write_text(_token(child.pid), encoding="ascii")
        for i in range(3):
            assert evidence.log_evidence({**EVENT, "payload": f"secret-looking text {i}"}, ledger, lock_wait=0.02) is None
    finally:
        child.kill()
        child.wait()
    assert Path(ledger + ".dropped").read_text() == "xxx"  # only a count, never content
    assert os.stat(ledger + ".dropped").st_mode & 0o777 == 0o600
    before = evidence.verify_evidence_ledger(ledger)
    assert before["valid"] and before["gaps"] == {"markers": 0, "events": 0, "pending": 3}
    os.unlink(lock)
    assert evidence.log_evidence({**EVENT, "payload": "after"}, ledger)
    recs = _lines(ledger)
    assert len(recs) == 3
    assert recs[1]["rule"] == "evidence-gap"
    assert recs[1]["reason"] == "3 events were not recorded (log busy)"
    assert recs[2]["prev_hash"] == recs[1]["record_hash"]
    assert not os.path.exists(ledger + ".dropped")
    after = evidence.verify_evidence_ledger(ledger)
    assert after["valid"] and after["gaps"] == {"markers": 1, "events": 3, "pending": 0}
    clean = str(tmp_path / "clean.jsonl")
    evidence.log_evidence(EVENT, clean)
    assert "gaps" not in evidence.verify_evidence_ledger(clean)


def test_one_dropped_event_reads_as_one_event(tmp_path):
    ledger = str(tmp_path / "evidence.jsonl")
    evidence.note_dropped(ledger, 1)
    assert evidence.log_evidence(EVENT, ledger)
    assert _lines(ledger)[0]["reason"] == "1 event was not recorded (log busy)"


def test_a_failed_write_gives_the_count_back(tmp_path, monkeypatch):
    ledger = str(tmp_path / "evidence.jsonl")
    evidence.note_dropped(ledger, 4)

    def boom(*a, **k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(evidence, "_open_for_append", boom)
    assert evidence.log_evidence(EVENT, ledger) is None
    monkeypatch.undo()
    assert Path(ledger + ".dropped").read_text() == "xxxx"
    assert [n for n in os.listdir(tmp_path) if ".taking-" in n] == []
    assert evidence.log_evidence(EVENT, ledger)
    assert evidence.verify_evidence_ledger(ledger)["gaps"] == {"markers": 1, "events": 4, "pending": 0}


_NODE_DRIVER = """
const ev = require(process.argv[2]);
const crypto = require('crypto');
const os = require('os');
const [mode, file, arg] = process.argv.slice(3);
if (mode === 'drop') ev.noteDropped(file, Number(arg));
else if (mode === 'write') ev.logEvidence({ agent: 'a', tool_name: 't', verdict: 'block', rule: 'R', phase: 'p' }, file, { noStats: true });
else if (mode === 'verify') process.stdout.write(JSON.stringify(ev.verifyEvidenceLedger(file)));
else if (mode === 'host') process.stdout.write(crypto.createHash('sha256').update(os.hostname().toLowerCase()).digest('hex').slice(0, 8));
"""


def _node(tmp_path, *args):
    driver = tmp_path / "driver.js"
    driver.write_text(_NODE_DRIVER, encoding="utf-8")
    r = subprocess.run([NODE, str(driver), str(NODE_EVIDENCE), *map(str, args)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return r.stdout


@needs_node
def test_the_machine_part_of_the_token_is_the_same_in_both_packages(tmp_path):
    assert _node(tmp_path, "host", "-") == evidence._host_tag()


@needs_node
def test_gap_record_written_by_python_is_shown_by_node_and_the_other_way_round(tmp_path):
    ledger = str(tmp_path / "evidence.jsonl")
    # Node counts, Python writes the record, Node verifies.
    _node(tmp_path, "drop", ledger, 2)
    assert evidence.log_evidence(EVENT, ledger)
    assert json.loads(_node(tmp_path, "verify", ledger))["gaps"] == {"markers": 1, "events": 2, "pending": 0}
    # Python counts, Node writes the record, Python verifies.
    evidence.note_dropped(ledger, 5)
    _node(tmp_path, "write", ledger)
    res = evidence.verify_evidence_ledger(ledger)
    assert res["valid"] and res["gaps"] == {"markers": 2, "events": 7, "pending": 0}
    node_res = json.loads(_node(tmp_path, "verify", ledger))
    assert node_res["valid"] and node_res["gaps"] == res["gaps"]


@needs_node
@posix_only
def test_a_lock_of_the_node_package_with_a_dead_owner_is_broken_by_python(tmp_path):
    ledger = str(tmp_path / "evidence.jsonl")
    # Take a lock as Node does (pid:hex:machine) for a process that has ended.
    Path(ledger + ".lock").write_text(f"{_dead_pid()}:{secrets.token_hex(8)}:{_node(tmp_path, 'host', '-')}", encoding="ascii")
    started = time.monotonic()
    assert evidence.log_evidence(EVENT, ledger, lock_wait=5.0)
    assert time.monotonic() - started < 1.5
    assert evidence.verify_evidence_ledger(ledger)["valid"]
