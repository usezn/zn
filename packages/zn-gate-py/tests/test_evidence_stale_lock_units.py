"""Direct tests of the stale lock helpers in evidence.py, in a temporary folder."""
import os
import time

from zn_gate import evidence

TOKEN = "4242:abcdef0123456789"


def _file(path, text="x", age=0.0):
    with open(path, "w") as f:
        f.write(text)
    if age:
        t = time.time() - age
        os.utime(path, (t, t))
    return str(path)


def test_break_stale_lock_removes_a_lock_left_by_a_dead_process(tmp_path):
    lock = _file(tmp_path / "ledger.lock", "1:dead", age=60)
    assert evidence._break_stale_lock(lock, TOKEN) is True
    assert sorted(os.listdir(tmp_path)) == []  # lock, mutex and renamed copy are all gone


def test_break_stale_lock_keeps_a_fresh_lock_and_asks_for_a_retry(tmp_path):
    lock = _file(tmp_path / "ledger.lock", "5:alive")
    assert evidence._break_stale_lock(lock, TOKEN) is True
    with open(lock) as f:
        assert f.read() == "5:alive"
    assert not os.path.exists(lock + ".break")


def test_break_stale_lock_with_no_lock_asks_for_a_retry(tmp_path):
    lock = str(tmp_path / "ledger.lock")
    assert evidence._break_stale_lock(lock, TOKEN) is True
    assert os.listdir(tmp_path) == []


def test_break_stale_lock_gives_up_when_a_fresh_mutex_exists(tmp_path):
    lock = _file(tmp_path / "ledger.lock", "1:dead", age=60)
    mutex = _file(tmp_path / "ledger.lock.break", "9:other")
    assert evidence._break_stale_lock(lock, TOKEN) is False
    assert os.path.exists(lock)
    with open(mutex) as f:
        assert f.read() == "9:other"


def test_break_stale_lock_sweeps_old_leftovers_but_not_other_files(tmp_path):
    lock = _file(tmp_path / "ledger.lock", "1:dead", age=60)
    old = _file(tmp_path / "ledger.lock.stale-old", age=60)
    other = _file(tmp_path / "other.lock.stale-old", age=60)
    assert evidence._break_stale_lock(lock, TOKEN) is True
    assert not os.path.exists(old)
    assert os.path.exists(other)


def test_reclaim_stale_mutex_removes_an_old_mutex_and_leaves_no_copy(tmp_path):
    mutex = _file(tmp_path / "ledger.lock.break", "1:dead", age=60)
    evidence._reclaim_stale_mutex(mutex, TOKEN)
    assert os.listdir(tmp_path) == []


def test_reclaim_stale_mutex_leaves_a_fresh_mutex_alone(tmp_path):
    mutex = _file(tmp_path / "ledger.lock.break", "9:alive")
    evidence._reclaim_stale_mutex(mutex, TOKEN)
    with open(mutex) as f:
        assert f.read() == "9:alive"
    assert os.listdir(tmp_path) == ["ledger.lock.break"]


def test_reclaim_stale_mutex_ignores_a_missing_mutex(tmp_path):
    evidence._reclaim_stale_mutex(str(tmp_path / "ledger.lock.break"), TOKEN)
    assert os.listdir(tmp_path) == []


def test_reclaim_stale_mutex_treats_a_future_dated_mutex_as_stale(tmp_path):
    mutex = _file(tmp_path / "ledger.lock.break", "1:dead", age=-3600)
    evidence._reclaim_stale_mutex(mutex, TOKEN)
    assert not os.path.exists(mutex)


def test_reclaim_stale_mutex_puts_back_a_mutex_that_became_fresh(tmp_path, monkeypatch):
    mutex = _file(tmp_path / "ledger.lock.break", "1:dead", age=60)

    def touch(path):
        os.utime(path, None)  # its owner refreshed it after we looked

    monkeypatch.setitem(evidence._test_hooks, "before_mutex_reclaim", touch)
    evidence._reclaim_stale_mutex(mutex, TOKEN)
    with open(mutex) as f:
        assert f.read() == "1:dead"
    assert os.listdir(tmp_path) == ["ledger.lock.break"]


def test_sweep_removes_old_leftovers_and_keeps_recent_and_unrelated_files(tmp_path):
    lock = str(tmp_path / "ledger.lock")
    _file(tmp_path / "ledger.lock.stale-a", age=60)
    _file(tmp_path / "ledger.lock.stale-b", age=-3600)  # dated in the future
    _file(tmp_path / "ledger.lock.stale-c")
    _file(tmp_path / "ledger.lock.break", age=60)
    _file(tmp_path / "ledger.jsonl", age=60)
    evidence._sweep_stale_leftovers(lock)
    assert sorted(os.listdir(tmp_path)) == [
        "ledger.jsonl", "ledger.lock.break", "ledger.lock.stale-c",
    ]


def test_sweep_looks_at_no_more_than_five_leftovers(tmp_path):
    lock = str(tmp_path / "ledger.lock")
    for i in range(9):
        _file(tmp_path / f"ledger.lock.stale-{i}", age=60)
    evidence._sweep_stale_leftovers(lock)
    assert len(os.listdir(tmp_path)) == 4


def test_sweep_ignores_a_missing_folder(tmp_path):
    evidence._sweep_stale_leftovers(str(tmp_path / "missing" / "ledger.lock"))


def test_sweep_uses_the_current_folder_for_a_bare_lock_name(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _file(tmp_path / "ledger.lock.stale-old", age=60)
    evidence._sweep_stale_leftovers("ledger.lock")
    assert os.listdir(tmp_path) == []
