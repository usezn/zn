"""The ledger lock wait is configurable (ZN_EVIDENCE_LOCK_WAIT_MS, longer on a network file system) and an event
that cannot be written is counted and shown by `zn-gate stats`, as in the npm package. No real NFS."""
import os

import pytest

from zn_gate import evidence, stats


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    monkeypatch.delenv("ZN_EVIDENCE_LOCK_WAIT_MS", raising=False)
    monkeypatch.setattr(evidence, "_last_write_warn", None)
    return tmp_path


def test_wait_default_and_env_override(home, monkeypatch):
    f = str(home / "a" / "evidence.jsonl")
    assert evidence.lock_wait_for(f) == 2.0
    monkeypatch.setenv("ZN_EVIDENCE_LOCK_WAIT_MS", "7500")
    assert evidence.lock_wait_for(f) == 7.5
    for bad in ["abc", "-5", "1.5", "", "600001"]:
        monkeypatch.setenv("ZN_EVIDENCE_LOCK_WAIT_MS", bad)
        assert evidence.lock_wait_for(f) == 2.0, bad


def test_network_fs_detection_and_longer_default(home, monkeypatch):
    d = home / "mnt" / "share"
    d.mkdir(parents=True)
    real = os.path.realpath(str(home))
    mounts = home / "mounts"
    mounts.write_text("/dev/sda1 / ext4 rw 0 0\nsrv:/x %s/mnt nfs4 rw 0 0\n" % real)
    assert evidence.on_network_fs(str(d), str(mounts)) is True
    mounts.write_text("//srv/x %s/mnt cifs rw 0 0\n" % real)
    assert evidence.on_network_fs(str(d), str(mounts)) is True
    mounts.write_text("srv:/x %s/mnt nfs rw 0 0\n/dev/sdb %s/mnt/share ext4 rw 0 0\n" % (real, real))
    assert evidence.on_network_fs(str(d), str(mounts)) is False
    assert evidence.on_network_fs(str(d), str(home / "missing")) is False
    monkeypatch.setattr(evidence, "on_network_fs", lambda directory: True)
    assert evidence.lock_wait_for(str(d / "evidence.jsonl")) == 10.0


def test_dropped_event_is_counted_and_shown(home):
    ledger = str(home / "evidence.jsonl")
    assert stats.dropped_count() == 0
    with open(ledger + ".lock", "w") as f:
        f.write("%d:held" % os.getpid())  # a fresh lock held by someone else
    assert evidence.log_evidence({"payload": "x"}, ledger, lock_wait=0.05) is None
    assert evidence.log_evidence({"payload": "y"}, ledger, lock_wait=0.05) is None
    assert stats.dropped_count() == 2
    s = stats.summary()
    assert s["evidenceDropped"] == 2
    text = stats.render(s)
    assert "2 evidence log events could not be written" in text
    assert "ZN_EVIDENCE_LOCK_WAIT_MS" in text


def test_nothing_counted_on_success_and_silent_at_zero(home):
    ledger = str(home / "evidence.jsonl")
    assert evidence.log_evidence({"payload": "z"}, ledger) is not None
    assert stats.dropped_count() == 0
    assert "could not be written" not in stats.render(stats.summary())


def test_env_wait_used_when_none_passed(home, monkeypatch):
    ledger = str(home / "evidence.jsonl")
    with open(ledger + ".lock", "w") as f:
        f.write("%d:held" % os.getpid())
    monkeypatch.setenv("ZN_EVIDENCE_LOCK_WAIT_MS", "0")
    assert evidence.log_evidence({"payload": "x"}, ledger) is None
    assert stats.dropped_count() == 1
