import errno
import os
import time

import pytest

from zn_gate import evidence
from zn_gate.evidence import GENESIS_HASH, log_evidence

EVENT = {
    "agent": "langchain-agent",
    "tool_name": "bash",
    "payload": "echo hello",
    "verdict": "ALLOW",
}


def _fail_first_os_write(monkeypatch):
    """Makes the first os.write call fail with ENOSPC. In _acquire_lock that call is the token
    write, because the lock is created with os.open first and the ledger is written with open()."""
    state = {"left": 1}
    real_write = os.write

    def fake_write(fd, data):
        if state["left"] > 0:
            state["left"] -= 1
            raise OSError(errno.ENOSPC, "No space left on device")
        return real_write(fd, data)

    monkeypatch.setattr(evidence.os, "write", fake_write)
    return state


def _make_stale_lock(lock_path):
    with open(lock_path, "w", encoding="ascii") as fh:
        fh.write("999999:deadbeef")
    old = time.time() - 3600
    os.utime(lock_path, (old, old))


def test_acquire_lock_enospc_removes_lock_and_raises(tmp_path, monkeypatch):
    lock_path = str(tmp_path / "evidence.jsonl.lock")
    _fail_first_os_write(monkeypatch)

    with pytest.raises(OSError) as info:
        evidence._acquire_lock(lock_path)

    assert info.value.errno == errno.ENOSPC
    assert not os.path.exists(lock_path)


def test_enospc_on_token_write_then_next_write_works_at_once(tmp_path, monkeypatch, capsys):
    ledger = str(tmp_path / "evidence.jsonl")
    lock_path = ledger + ".lock"
    state = _fail_first_os_write(monkeypatch)

    assert log_evidence(dict(EVENT), file_path=ledger) is None
    assert state["left"] == 0
    assert not os.path.exists(lock_path)
    assert "cannot write to the evidence log" in capsys.readouterr().err

    # Disk space is back: the very next write must be recorded, not skipped for LOCK_STALE seconds.
    record = log_evidence(dict(EVENT), file_path=ledger)
    assert record is not None
    assert record["prev_hash"] == GENESIS_HASH
    assert not os.path.exists(lock_path)
    with open(ledger, "r", encoding="utf-8") as fh:
        assert len(fh.readlines()) == 1
    assert "another process is writing" not in capsys.readouterr().err


def test_normal_write_leaves_no_lock(tmp_path):
    ledger = str(tmp_path / "evidence.jsonl")

    record = log_evidence(dict(EVENT), file_path=ledger)

    assert record is not None
    assert record["prev_hash"] == GENESIS_HASH
    assert not os.path.exists(ledger + ".lock")


def test_break_mutex_enospc_removes_mutex_and_next_break_works(tmp_path, monkeypatch):
    lock_path = str(tmp_path / "evidence.jsonl.lock")
    mutex = lock_path + ".break"
    _make_stale_lock(lock_path)
    _fail_first_os_write(monkeypatch)  # the first write in _break_stale_lock is the mutex token

    with pytest.raises(OSError) as info:
        evidence._break_stale_lock(lock_path, "1:aaaa")

    assert info.value.errno == errno.ENOSPC
    assert not os.path.exists(mutex)
    assert os.path.exists(lock_path)  # the stale lock is not touched when the break fails

    # Space is back: breaking the same stale lock works at once.
    monkeypatch.undo()
    assert evidence._break_stale_lock(lock_path, "1:aaaa") is True
    assert not os.path.exists(lock_path)
    assert not os.path.exists(mutex)


def test_acquire_over_stale_lock_after_enospc_on_mutex_then_succeeds(tmp_path, monkeypatch):
    lock_path = str(tmp_path / "evidence.jsonl.lock")
    _make_stale_lock(lock_path)
    _fail_first_os_write(monkeypatch)

    with pytest.raises(OSError):
        evidence._acquire_lock(lock_path, 1.0)
    assert not os.path.exists(lock_path + ".break")

    monkeypatch.undo()
    token = evidence._acquire_lock(lock_path, 1.0)
    assert evidence._read_lock_token(lock_path) == token
