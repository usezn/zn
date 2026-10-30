"""Edge cases of log_evidence (no wait for the lock, read-only folder) and of the
limit argument of get_evidence_stats."""
import os
import time

import pytest

from zn_gate import evidence
from zn_gate.evidence import get_evidence_stats, log_evidence


@pytest.fixture(autouse=True)
def _reset_warning(monkeypatch):
    monkeypatch.setattr(evidence, "_last_warn", None)
    monkeypatch.setattr(evidence, "_last_write_warn", None)


_posix_user = pytest.mark.skipif(
    os.name != "posix" or (hasattr(os, "getuid") and os.getuid() == 0),
    reason="needs POSIX permissions and a non-root user",
)


def _write(path, n):
    for i in range(n):
        assert log_evidence({"payload": f"p{i}", "tool_name": "bash", "verdict": "allow"},
                            file_path=path) is not None


def test_lock_wait_zero_with_held_lock_returns_none_at_once(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    _write(p, 1)
    with open(p + ".lock", "w") as f:
        f.write("99999")
    before = open(p, "rb").read()
    t0 = time.monotonic()
    assert log_evidence({"payload": "blocked"}, file_path=p, lock_wait=0) is None
    assert time.monotonic() - t0 < 1.0
    assert open(p, "rb").read() == before
    assert os.path.exists(p + ".lock")


def test_lock_wait_zero_without_lock_still_writes(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    assert log_evidence({"payload": "x"}, file_path=p, lock_wait=0) is not None
    assert not os.path.exists(p + ".lock")


@_posix_user
def test_read_only_folder_returns_none_without_raising(tmp_path):
    sub = tmp_path / "ro"
    sub.mkdir(mode=0o500)
    try:
        assert log_evidence({"payload": "x"}, file_path=str(sub / "evidence.jsonl")) is None
        assert os.listdir(sub) == []
    finally:
        os.chmod(sub, 0o700)


def test_stats_limit_zero_keeps_counts_but_no_recent(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    _write(p, 3)
    s = get_evidence_stats(file_path=p, limit=0)
    assert s["total"] == 3
    assert s["allows"] == 3
    assert s["recent"] == []


def test_stats_limit_one_returns_the_newest_record(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    _write(p, 3)
    s = get_evidence_stats(file_path=p, limit=1)
    assert s["total"] == 3
    assert len(s["recent"]) == 1
    assert s["recent"][0]["record_hash"] == evidence.get_last_hash(p)


def test_stats_limit_larger_than_file_returns_all_newest_first(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    _write(p, 3)
    s = get_evidence_stats(file_path=p, limit=100)
    assert s["total"] == 3
    assert len(s["recent"]) == 3
    assert s["recent"][0]["record_hash"] == evidence.get_last_hash(p)
    assert s["recent"][-1]["prev_hash"] == evidence.GENESIS_HASH
