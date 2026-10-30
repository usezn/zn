"""Lock handling in the evidence ledger: stale locks, the break mutex, leftovers and timeouts."""
import os
import time

import pytest

from zn_gate import evidence
from zn_gate.evidence import EvidenceLockError


@pytest.fixture(autouse=True)
def _clean_hooks(monkeypatch):
    monkeypatch.setattr(evidence, "_test_hooks", {})


def _age(path, seconds):
    t = time.time() - seconds
    os.utime(path, (t, t))


def _write(path, text="1:abc"):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def test_recovery_hint_uses_move_on_windows(monkeypatch):
    monkeypatch.setattr(evidence.os, "name", "nt")
    hint = evidence.recovery_hint("/tmp/example/evidence.jsonl")
    assert "move " in hint
    assert "evidence.damaged.jsonl" in hint


def test_acquire_lock_times_out_on_a_fresh_lock(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    _write(lock)
    with pytest.raises(EvidenceLockError):
        evidence._acquire_lock(lock, wait=0.05)
    assert os.path.exists(lock)


def test_acquire_lock_breaks_a_stale_lock(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    _write(lock)
    _age(lock, evidence.LOCK_STALE + 60)
    token = evidence._acquire_lock(lock, wait=2.0)
    assert evidence._owns_lock(lock, token)
    assert not os.path.exists(lock + ".break")
    evidence._release_lock(lock, token)
    assert not os.path.exists(lock)


def test_acquire_lock_breaks_a_lock_dated_in_the_future(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    _write(lock)
    _age(lock, -(evidence.LOCK_STALE + 60))
    token = evidence._acquire_lock(lock, wait=2.0)
    assert evidence._owns_lock(lock, token)


def test_break_keeps_a_lock_that_is_not_stale(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    _write(lock)
    assert evidence._break_stale_lock(lock, "2:tok") is True
    assert os.path.exists(lock)
    assert not os.path.exists(lock + ".break")


def test_break_returns_when_lock_is_already_gone(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    assert evidence._break_stale_lock(lock, "2:tok") is True
    assert not os.path.exists(lock + ".break")


def test_break_puts_back_a_lock_that_became_fresh(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    _write(lock, "3:other")
    _age(lock, evidence.LOCK_STALE + 60)
    real_stat = os.stat
    calls = {"n": 0}

    def fake_stat(p, *a, **k):
        st = real_stat(p, *a, **k)
        if str(p).startswith(lock + ".stale-"):
            calls["n"] += 1
            class S:  # the moved file looks fresh
                st_mtime = time.time()
            return S()
        return st

    import unittest.mock as mock
    with mock.patch.object(evidence.os, "stat", fake_stat):
        assert evidence._break_stale_lock(lock, "2:tok") is True
    assert calls["n"] == 1
    assert evidence._read_lock_token(lock) == "3:other"
    assert os.listdir(tmp_path) == ["evidence.jsonl.lock"]


def test_break_removes_stale_leftovers(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    _write(lock)
    _age(lock, evidence.LOCK_STALE + 60)
    old = str(tmp_path / "evidence.jsonl.lock.stale-9-old")
    new = str(tmp_path / "evidence.jsonl.lock.stale-9-new")
    other = str(tmp_path / "unrelated.txt")
    for p in (old, new, other):
        _write(p)
    _age(old, evidence.LOCK_STALE + 60)
    assert evidence._break_stale_lock(lock, "2:tok") is True
    assert not os.path.exists(lock)
    assert not os.path.exists(old)
    assert os.path.exists(new)
    assert os.path.exists(other)


def test_sweep_stops_after_a_few_leftovers(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    paths = [str(tmp_path / f"evidence.jsonl.lock.stale-{i}") for i in range(8)]
    for p in paths:
        _write(p)
        _age(p, evidence.LOCK_STALE + 60)
    evidence._sweep_stale_leftovers(lock)
    assert sum(os.path.exists(p) for p in paths) == 3


def test_sweep_ignores_a_missing_directory(tmp_path):
    evidence._sweep_stale_leftovers(str(tmp_path / "nope" / "evidence.jsonl.lock"))


def test_busy_break_mutex_is_left_alone_when_fresh(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    mutex = lock + ".break"
    _write(lock)
    _write(mutex, "4:other")
    assert evidence._break_stale_lock(lock, "2:tok") is False
    assert evidence._read_lock_token(mutex) == "4:other"


def test_stale_break_mutex_is_reclaimed(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    mutex = lock + ".break"
    _write(mutex, "4:dead")
    _age(mutex, evidence.LOCK_STALE + 60)
    assert evidence._break_stale_lock(lock, "2:tok") is False
    assert not os.path.exists(mutex)
    assert os.listdir(tmp_path) == []


def test_reclaim_puts_back_a_mutex_that_became_fresh(tmp_path):
    mutex = str(tmp_path / "evidence.jsonl.lock.break")
    _write(mutex, "4:live")
    _age(mutex, evidence.LOCK_STALE + 60)

    def refresh(path):
        # Between the staleness check and the move, the owner touches the mutex.
        os.utime(path, None)

    evidence._test_hooks["before_mutex_reclaim"] = refresh
    evidence._reclaim_stale_mutex(mutex, "2:tok")
    assert evidence._read_lock_token(mutex) == "4:live"
    assert os.listdir(tmp_path) == ["evidence.jsonl.lock.break"]


def test_reclaim_ignores_a_missing_mutex(tmp_path):
    evidence._reclaim_stale_mutex(str(tmp_path / "missing.break"), "2:tok")


def test_release_mutex_only_removes_its_own(tmp_path):
    mutex = str(tmp_path / "m.break")
    _write(mutex, "4:other")
    evidence._release_mutex(mutex, "2:tok")
    assert os.path.exists(mutex)
    evidence._release_mutex(mutex, "4:other")
    assert not os.path.exists(mutex)


def test_unlink_lock_tolerates_a_missing_file(tmp_path):
    evidence._unlink_lock(str(tmp_path / "none.lock"))


def test_release_lock_keeps_a_lock_owned_by_someone_else(tmp_path):
    lock = str(tmp_path / "evidence.jsonl.lock")
    _write(lock, "5:other")
    evidence._release_lock(lock, "2:tok")
    assert evidence._read_lock_token(lock) == "5:other"
