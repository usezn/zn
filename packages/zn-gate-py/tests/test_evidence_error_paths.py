"""Evidence ledger error paths, with temp ledgers: a cut-off last record, an unreadable file and a
lock that cannot be taken. Each reports the damage or fails closed (writes nothing) with a plain message."""
import errno
import json
import os

import pytest

from zn_gate import evidence
from zn_gate.evidence import (
    EvidenceLedgerError,
    EvidenceLockError,
    export_evidence_ledger,
    get_evidence_stats,
    log_evidence,
    verify_evidence_ledger,
)


@pytest.fixture(autouse=True)
def _reset_warnings(monkeypatch):
    monkeypatch.setattr(evidence, "_last_warn", None)
    monkeypatch.setattr(evidence, "_last_write_warn", None)


def _ledger(tmp_path, count=2):
    path = str(tmp_path / "ledger.jsonl")
    for i in range(count):
        assert log_evidence({"verdict": "allow", "payload": f"p{i}"}, file_path=path) is not None
    return path


class _OsAs:
    """The os module, but reporting another os.name (for Windows-only branches)."""

    def __init__(self, name):
        self.name = name

    def __getattr__(self, attr):
        return getattr(os, attr)


# ---- the trailing-newline check ----

def test_newline_check_on_an_intact_empty_and_cut_file(tmp_path):
    path = _ledger(tmp_path)
    assert evidence._ends_with_newline(path) is True
    empty = tmp_path / "empty.jsonl"
    empty.write_bytes(b"")
    assert evidence._ends_with_newline(str(empty)) is True
    with open(path, "rb") as f:
        cut = f.read()[:-1]
    with open(path, "wb") as f:
        f.write(cut)
    assert evidence._ends_with_newline(path) is False


def test_newline_check_cannot_read_means_no_cut_tail(tmp_path):
    # Unreadable: answer "ends with a newline", so a damaged last line stays a tamper report.
    missing = str(tmp_path / "missing.jsonl")
    assert evidence._ends_with_newline(missing) is True
    assert evidence._is_cut_tail(missing, '{"id":"ev_1","verdict":') is False


def test_cut_tail_needs_a_record_start_and_no_newline(tmp_path):
    path = tmp_path / "ledger.jsonl"
    path.write_bytes(b'{"id":"ev_abc","verd')
    assert evidence._is_cut_tail(str(path), '{"id":"ev_abc","verd') is True
    assert evidence._is_cut_tail(str(path), '{"other":"verd') is False
    path.write_bytes(b'{"id":"ev_abc","verd\n')
    assert evidence._is_cut_tail(str(path), '{"id":"ev_abc","verd') is False


def test_verify_says_the_last_record_was_cut_off(tmp_path):
    path = _ledger(tmp_path, 3)
    with open(path, "rb") as f:
        data = f.read()
    with open(path, "wb") as f:
        f.write(data[:-20])
    res = verify_evidence_ledger(path)
    assert res["valid"] is False
    assert res["truncated_tail"] is True
    assert res["broken_index"] == 2
    assert res["verified"] == 2
    assert evidence.TRUNCATED_TAIL_MESSAGE in res["error"]


def test_a_new_write_after_a_cut_off_record_writes_nothing(tmp_path, capsys):
    path = _ledger(tmp_path)
    with open(path, "rb") as f:
        data = f.read()
    with open(path, "wb") as f:
        f.write(data[:-20])
    size = os.path.getsize(path)
    assert log_evidence({"verdict": "allow"}, file_path=path) is None
    assert os.path.getsize(path) == size
    err = capsys.readouterr().err
    assert "is damaged" in err
    assert "Events are not being recorded" in err
    assert "zn-gate evidence --verify" in err
    assert not os.path.exists(path + ".lock")


def test_the_damaged_log_warning_is_not_repeated_at_once(tmp_path, capsys):
    path = _ledger(tmp_path)
    with open(path, "ab") as f:
        f.write(b"not json at all")
    assert log_evidence({"verdict": "allow"}, file_path=path) is None
    assert "is damaged" in capsys.readouterr().err
    assert log_evidence({"verdict": "allow"}, file_path=path) is None
    assert capsys.readouterr().err == ""


# ---- reading an unreadable ledger (a directory stands in for a file that cannot be read) ----

def _unreadable(tmp_path):
    d = tmp_path / "unreadable.jsonl"
    d.mkdir(exist_ok=True)
    return str(d)


def test_stats_of_an_unreadable_ledger_are_invalid_with_the_reason(tmp_path):
    res = get_evidence_stats(_unreadable(tmp_path))
    assert res["valid"] is False
    assert res["total"] == 0
    assert "Cannot read the evidence log" in res["error"]
    assert res["recent"] == []


def test_export_of_an_unreadable_ledger_is_empty_and_invalid(tmp_path):
    for fmt in ("jsonl", "csv"):
        res = export_evidence_ledger(_unreadable(tmp_path), fmt)
        assert res["valid"] is False
        assert "Cannot read the evidence log" in res["error"]
        assert res["total"] == 0
        assert res["tip_hash"] == evidence.GENESIS_HASH


def test_export_jsonl_that_cannot_be_read_gives_a_lone_newline(tmp_path, monkeypatch):
    path = _ledger(tmp_path)
    real_open = open

    def flaky_open(file, mode="r", *args, **kwargs):
        if str(file) == path and mode == "rb" and flaky_open.calls >= 2:
            raise OSError(errno.EIO, "Input/output error")
        flaky_open.calls += 1
        return real_open(file, mode, *args, **kwargs)

    flaky_open.calls = 0
    monkeypatch.setattr("builtins.open", flaky_open)
    res = export_evidence_ledger(path, "jsonl")
    monkeypatch.undo()
    assert res["content"] == "\n"
    assert res["format"] == "jsonl"


def test_a_write_to_an_unreadable_ledger_writes_a_warning_not_an_error(tmp_path, capsys):
    assert log_evidence({"verdict": "allow"}, file_path=_unreadable(tmp_path)) is None
    err = capsys.readouterr().err
    assert "Events are not being recorded" in err


# ---- the lock ----

def test_a_busy_lock_means_nothing_is_written(tmp_path, capsys):
    path = _ledger(tmp_path)
    size = os.path.getsize(path)
    with open(path + ".lock", "w") as f:
        f.write(f"{os.getpid()}:someone-else")
    assert log_evidence({"verdict": "allow"}, file_path=path, lock_wait=0.05) is None
    assert os.path.getsize(path) == size
    err = capsys.readouterr().err
    assert "cannot write to the evidence log" in err
    assert "another process is writing to the log" in err
    # The other writer's lock is not ours to remove.
    with open(path + ".lock") as f:
        assert f.read().endswith("someone-else")


def test_a_lock_that_cannot_be_created_is_reported_and_writes_nothing(tmp_path, capsys, monkeypatch):
    path = _ledger(tmp_path)
    size = os.path.getsize(path)
    real_open = os.open

    def denied(p, flags, *args, **kwargs):
        if str(p).endswith(".lock"):
            raise PermissionError(errno.EACCES, "Permission denied")
        return real_open(p, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", denied)
    assert log_evidence({"verdict": "allow"}, file_path=path) is None
    monkeypatch.undo()
    assert os.path.getsize(path) == size
    err = capsys.readouterr().err
    assert "cannot write to the evidence log" in err
    assert "Permission denied" in err


def test_the_lock_token_cannot_be_written_leaves_no_lock_behind(tmp_path, monkeypatch):
    lock = str(tmp_path / "ledger.jsonl.lock")

    def full_disk(fd, data):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(os, "write", full_disk)
    with pytest.raises(OSError):
        evidence._acquire_lock(lock, wait=0.05)
    monkeypatch.undo()
    assert not os.path.exists(lock)


def test_windows_busy_error_while_the_lock_exists_waits_then_reports_busy(tmp_path, monkeypatch):
    lock = tmp_path / "ledger.jsonl.lock"
    lock.write_text("1:other")
    real_open = os.open

    def eperm(p, flags, *args, **kwargs):
        if str(p) == str(lock):
            raise PermissionError(errno.EPERM, "Operation not permitted")
        return real_open(p, flags, *args, **kwargs)

    monkeypatch.setattr(evidence, "os", _OsAs("nt"))
    monkeypatch.setattr(os, "open", eperm)
    with pytest.raises(EvidenceLockError, match="another process is writing"):
        evidence._acquire_lock(str(lock), wait=0.05)


def test_windows_busy_error_with_no_lock_present_is_a_permission_problem(tmp_path, monkeypatch):
    lock = str(tmp_path / "ledger.jsonl.lock")
    real_open = os.open

    def eacces(p, flags, *args, **kwargs):
        if str(p) == lock:
            raise PermissionError(errno.EACCES, "Access is denied")
        return real_open(p, flags, *args, **kwargs)

    monkeypatch.setattr(evidence, "os", _OsAs("nt"))
    monkeypatch.setattr(os, "open", eacces)
    with pytest.raises(PermissionError):
        evidence._acquire_lock(lock, wait=5)


def test_other_errors_on_the_lock_are_raised_at_once_on_any_system(tmp_path, monkeypatch):
    lock = str(tmp_path / "ledger.jsonl.lock")
    real_open = os.open

    def eio(p, flags, *args, **kwargs):
        if str(p) == lock:
            raise OSError(errno.EIO, "Input/output error")
        return real_open(p, flags, *args, **kwargs)

    monkeypatch.setattr(evidence, "os", _OsAs("nt"))
    monkeypatch.setattr(os, "open", eio)
    with pytest.raises(OSError) as info:
        evidence._acquire_lock(lock, wait=5)
    assert info.value.errno == errno.EIO


def test_chain_is_unchanged_after_all_these_failures(tmp_path):
    path = _ledger(tmp_path, 3)
    with open(path + ".lock", "w") as f:
        f.write("1:other")
    log_evidence({"verdict": "allow"}, file_path=path, lock_wait=0.05)
    os.unlink(path + ".lock")
    assert verify_evidence_ledger(path)["valid"] is True
    with open(path, "rb") as f:
        assert len(f.read().splitlines()) == 3
    assert json.loads(open(path, "rb").read().splitlines()[-1])["prev_hash"]
