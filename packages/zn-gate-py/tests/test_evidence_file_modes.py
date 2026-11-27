"""Evidence ledger file modes: cases not covered by test_evidence_modes.py.

A new ledger is created 0600 even under a permissive umask, an existing ledger that
others can read is restricted to 0600 when it is opened, and a new ledger folder is
created 0700. The mode changes are POSIX only; on Windows they are skipped.
"""

import os
import stat

import pytest

from zn_gate import evidence
from zn_gate.evidence import log_evidence, verify_evidence_ledger

posix_only = pytest.mark.skipif(os.name != "posix", reason="file modes are POSIX only")


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def _event(n=0):
    return {"agent": "mode-test", "payload": f"example event {n}", "verdict": "allow"}


@pytest.fixture
def open_umask():
    old = os.umask(0)
    try:
        yield
    finally:
        os.umask(old)


@posix_only
def test_new_ledger_is_0600_even_with_an_open_umask(tmp_path, open_umask):
    ledger = tmp_path / "evidence.jsonl"
    assert log_evidence(_event(), file_path=str(ledger)) is not None
    assert _mode(ledger) == 0o600


@posix_only
def test_new_ledger_folder_is_0700_even_with_an_open_umask(tmp_path, open_umask):
    folder = tmp_path / "zn"
    ledger = folder / "evidence.jsonl"
    assert log_evidence(_event(), file_path=str(ledger)) is not None
    assert _mode(folder) == 0o700
    assert _mode(ledger) == 0o600


@posix_only
def test_new_ledger_folder_is_exactly_0700_inside_a_setgid_parent(tmp_path, open_umask):
    parent = tmp_path / "shared"
    parent.mkdir()
    os.chmod(parent, 0o2775)
    folder = parent / "zn"
    assert log_evidence(_event(), file_path=str(folder / "evidence.jsonl")) is not None
    assert _mode(folder) == 0o700


@posix_only
def test_open_for_append_creates_a_missing_file_0600(tmp_path, open_umask):
    ledger = tmp_path / "evidence.jsonl"
    with evidence._open_for_append(str(ledger)):
        pass
    assert ledger.exists()
    assert _mode(ledger) == 0o600


@posix_only
@pytest.mark.parametrize("loose", [0o644, 0o640, 0o604, 0o666])
def test_open_for_append_restricts_a_loose_existing_file(tmp_path, loose):
    ledger = tmp_path / "evidence.jsonl"
    ledger.write_text("", encoding="utf-8")
    os.chmod(ledger, loose)
    with evidence._open_for_append(str(ledger)):
        pass
    assert _mode(ledger) == 0o600


@posix_only
def test_open_for_append_keeps_a_private_file_as_it_is(tmp_path):
    ledger = tmp_path / "evidence.jsonl"
    ledger.write_text("", encoding="utf-8")
    os.chmod(ledger, 0o600)
    with evidence._open_for_append(str(ledger)):
        pass
    assert _mode(ledger) == 0o600


@posix_only
def test_existing_0644_ledger_keeps_its_records_when_restricted(tmp_path):
    ledger = tmp_path / "evidence.jsonl"
    first = log_evidence(_event(1), file_path=str(ledger))
    os.chmod(ledger, 0o644)
    second = log_evidence(_event(2), file_path=str(ledger))
    assert _mode(ledger) == 0o600
    assert second["prev_hash"] == first["record_hash"]
    result = verify_evidence_ledger(str(ledger))
    assert result["valid"] is True
    assert len(ledger.read_text(encoding="utf-8").splitlines()) == 2


@posix_only
def test_an_existing_folder_is_left_with_its_mode(tmp_path):
    folder = tmp_path / "zn"
    folder.mkdir()
    os.chmod(folder, 0o755)
    ledger = folder / "evidence.jsonl"
    assert log_evidence(_event(), file_path=str(ledger)) is not None
    assert _mode(folder) == 0o755
    assert _mode(ledger) == 0o600


@posix_only
def test_the_restriction_is_skipped_on_windows(tmp_path, monkeypatch):
    ledger = tmp_path / "evidence.jsonl"
    ledger.write_text("", encoding="utf-8")
    os.chmod(ledger, 0o644)
    calls = []
    monkeypatch.setattr(evidence.os, "fchmod", lambda fd, mode: calls.append(mode))
    monkeypatch.setattr(evidence.os, "name", "nt")
    with evidence._open_for_append(str(ledger)):
        pass
    monkeypatch.undo()
    assert calls == []
    assert _mode(ledger) == 0o644


@posix_only
def test_the_restriction_runs_on_posix(tmp_path, monkeypatch):
    ledger = tmp_path / "evidence.jsonl"
    ledger.write_text("", encoding="utf-8")
    os.chmod(ledger, 0o644)
    real_fchmod = os.fchmod
    calls = []

    def spy(fd, mode):
        calls.append(mode)
        real_fchmod(fd, mode)

    monkeypatch.setattr(evidence.os, "fchmod", spy)
    with evidence._open_for_append(str(ledger)):
        pass
    assert calls == [0o600]
    assert _mode(ledger) == 0o600
