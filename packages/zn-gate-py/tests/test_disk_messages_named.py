"""A full disk while the evidence log is written is said in plain words, with the file named (same as the Node CLI).

The error is simulated: no real disk is filled.
"""

import errno
from unittest import mock

from zn_gate import evidence


def test_full_disk_warning_names_the_log_in_plain_words(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(evidence, "_last_write_warn", None)
    path = str(tmp_path / "evidence.jsonl")
    err = OSError(errno.ENOSPC, "No space left on device")
    event = {"verdict": "block", "rule": "R", "tool_name": "t", "agent": "a"}
    with mock.patch.object(evidence, "_open_for_append", side_effect=err):
        assert evidence.log_evidence(event, path) is None
    out = capsys.readouterr().err
    assert f"cannot write to the evidence log {path}: the disk is full. Events are not being recorded" in out
    assert "No space left" not in out
    assert "ENOSPC" not in out


def test_fs_reason_maps_disk_errors_and_leaves_others_alone():
    assert evidence._fs_reason(OSError(errno.ENOSPC, "x")) == "the disk is full"
    assert evidence._fs_reason(OSError(errno.EROFS, "x")) == "the disk is read-only"
    assert evidence._fs_reason(OSError(errno.EACCES, "x")) == "your account is not allowed to write it"
    assert evidence._fs_reason(ValueError("x")) is None
