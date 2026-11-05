"""EvidenceLockError: raised when the write lock cannot be taken, and never leaked by log_evidence."""
import os

import pytest

from zn_gate import evidence
from zn_gate.evidence import EvidenceLockError, log_evidence


@pytest.fixture(autouse=True)
def _reset_warning(monkeypatch):
    monkeypatch.setattr(evidence, "_last_write_warn", None)


def test_is_a_plain_exception_not_an_os_error():
    assert issubclass(EvidenceLockError, Exception)
    assert not issubclass(EvidenceLockError, OSError)


def test_acquire_raises_when_the_lock_stays_busy(tmp_path):
    lock = str(tmp_path / "ledger.jsonl.lock")
    with open(lock, "w") as f:
        f.write("1:other")
    with pytest.raises(EvidenceLockError, match="another process is writing"):
        evidence._acquire_lock(lock, wait=0.05)
    with open(lock) as f:
        assert f.read() == "1:other"


def test_log_evidence_turns_it_into_a_warning_and_none(tmp_path, capsys):
    p = str(tmp_path / "ledger.jsonl")
    with open(p + ".lock", "w") as f:
        f.write("1:other")
    assert log_evidence({"payload": "x"}, file_path=p, lock_wait=0.05) is None
    err = capsys.readouterr().err
    assert "cannot write to the evidence log" in err
    assert "another process is writing to the log" in err
    assert not os.path.exists(p)


def test_taken_over_lock_writes_nothing(tmp_path, capsys, monkeypatch):
    p = str(tmp_path / "ledger.jsonl")
    monkeypatch.setattr(evidence, "_owns_lock", lambda lock_path, token: False)
    assert log_evidence({"payload": "x"}, file_path=p) is None
    assert "the write lock was taken over" in capsys.readouterr().err
    assert not os.path.exists(p)
