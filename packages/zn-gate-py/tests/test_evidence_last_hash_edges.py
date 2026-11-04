"""Edge cases for get_last_hash and recovery_hint: one entry, no final newline,
a whitespace-only file, a damaged last line and a ledger folder that does not exist."""
import os

import pytest

from zn_gate import evidence
from zn_gate.evidence import GENESIS_HASH, EvidenceLedgerError, get_last_hash, log_evidence


def test_single_entry_returns_its_hash_and_chains_from_genesis(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    rec = log_evidence({"payload": "example"}, file_path=p)
    assert rec["prev_hash"] == GENESIS_HASH
    assert get_last_hash(p) == rec["record_hash"]


def test_final_line_without_newline_is_read(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    log_evidence({"payload": "one"}, file_path=p)
    last = log_evidence({"payload": "two"}, file_path=p)
    with open(p, "rb") as f:
        data = f.read()
    assert data.endswith(b"\n")
    with open(p, "wb") as f:
        f.write(data.rstrip(b"\n"))
    assert get_last_hash(p) == last["record_hash"]


def test_whitespace_only_file_is_genesis(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    with open(p, "wb") as f:
        f.write(b" \t\r\n\n  \n")
    assert get_last_hash(p) == GENESIS_HASH


@pytest.mark.parametrize("tail", [b"{not json", b"[1, 2]", b"{}", b'{"record_hash": 5}'])
def test_damaged_last_line_raises_and_is_not_genesis(tmp_path, tail):
    p = str(tmp_path / "evidence.jsonl")
    log_evidence({"payload": "one"}, file_path=p)
    with open(p, "ab") as f:
        f.write(tail + b"\n")
    with pytest.raises(EvidenceLedgerError):
        get_last_hash(p)


def test_missing_ledger_folder_is_genesis_and_is_not_created(tmp_path):
    folder = tmp_path / "no" / "such" / "folder"
    assert get_last_hash(str(folder / "evidence.jsonl")) == GENESIS_HASH
    assert not folder.exists()


def test_log_evidence_creates_a_missing_folder(tmp_path):
    p = str(tmp_path / "new" / "folder" / "evidence.jsonl")
    rec = log_evidence({"payload": "example"}, file_path=p)
    assert rec["prev_hash"] == GENESIS_HASH
    assert get_last_hash(p) == rec["record_hash"]


def test_recovery_hint_uses_the_ledger_folder(tmp_path, monkeypatch):
    p = str(tmp_path / "evidence.jsonl")
    damaged = str(tmp_path / "evidence.damaged.jsonl")
    monkeypatch.setattr(evidence.os, "name", "posix")
    hint = evidence.recovery_hint(p)
    assert f'mv "{p}" "{damaged}"' in hint
    assert "new chain" in hint
    monkeypatch.setattr(evidence.os, "name", "nt")
    assert f'move "{p}" "{damaged}"' in evidence.recovery_hint(p)


def test_recovery_hint_for_a_folder_that_does_not_exist(tmp_path):
    p = str(tmp_path / "missing" / "evidence.jsonl")
    hint = evidence.recovery_hint(p)
    assert os.path.join(str(tmp_path / "missing"), "evidence.damaged.jsonl") in hint
    assert not (tmp_path / "missing").exists()
