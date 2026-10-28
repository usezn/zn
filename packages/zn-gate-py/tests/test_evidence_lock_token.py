"""The ledger lock is removed when its token cannot be written whole, so the next writer does not
wait for the stale timeout (parity with evidence.js). log_evidence keeps failing closed."""

import errno
import os
import time

import pytest

from zn_gate import evidence


def _event():
    return {"agent": "a", "tool_name": "t", "verdict": "block", "rule": "R"}


@pytest.mark.parametrize("kind", ["enospc", "short"])
def test_failed_token_write_removes_the_lock(tmp_path, monkeypatch, kind):
    ledger = str(tmp_path / "evidence.jsonl")
    real_write = os.write
    lock_fds = set()
    real_open = os.open

    def fake_open(p, flags, *a):
        fd = real_open(p, flags, *a)
        if str(p).endswith(".lock"):
            lock_fds.add(fd)
        return fd

    def fake_write(fd, data):
        if fd in lock_fds:
            if kind == "enospc":
                raise OSError(errno.ENOSPC, "No space left on device")
            return 3
        return real_write(fd, data)

    monkeypatch.setattr(os, "open", fake_open)
    monkeypatch.setattr(os, "write", fake_write)
    with pytest.raises(OSError) as info:
        evidence._acquire_lock(ledger + ".lock", wait=0.05)
    assert info.value.errno == errno.ENOSPC
    assert not os.path.exists(ledger + ".lock"), "the lock file must not stay behind"
    monkeypatch.undo()
    started = time.monotonic()
    token = evidence._acquire_lock(ledger + ".lock", wait=2)
    assert token and time.monotonic() - started < 1
