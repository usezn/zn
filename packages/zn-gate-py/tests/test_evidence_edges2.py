"""Branch cases for reading the ledger tail, reading the whole ledger and sweeping
leftovers of broken stale locks. Private helpers are reached through the public functions
unless the branch cannot be reached that way."""
import json
import os
import time

import pytest

from zn_gate import evidence
from zn_gate.evidence import (
    GENESIS_HASH,
    EvidenceLedgerError,
    get_last_hash,
    log_evidence,
    verify_evidence_ledger,
)

HASH_A = "a" * 64
HASH_B = "b" * 64


@pytest.fixture(autouse=True)
def _reset_warning(monkeypatch):
    monkeypatch.setattr(evidence, "_last_warn", None)
    monkeypatch.setattr(evidence, "_last_write_warn", None)


def _line(hash_, pad=0):
    rec = {"record_hash": hash_}
    if pad:
        rec["pad"] = "x" * pad
    return json.dumps(rec)


# ---- last line of the ledger (through get_last_hash) ----

def test_whitespace_only_file_starts_a_new_chain(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_bytes(b" \t\r\n\n  \n")
    assert get_last_hash(str(p)) == GENESIS_HASH


def test_empty_file_starts_a_new_chain(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_bytes(b"")
    assert get_last_hash(str(p)) == GENESIS_HASH


def test_single_line_without_newline_is_the_last_line(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_text(_line(HASH_A))
    assert get_last_hash(str(p)) == HASH_A


def test_trailing_blank_lines_and_spaces_are_skipped(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_text(_line(HASH_A) + "\n" + _line(HASH_B) + "  \t\r\n\n\n \n")
    assert get_last_hash(str(p)) == HASH_B


def test_last_line_longer_than_the_first_window_is_read_whole(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_text(_line(HASH_A) + "\n" + _line(HASH_B, pad=200_000) + "\n")
    assert get_last_hash(str(p)) == HASH_B


def test_long_single_line_is_read_from_the_start(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_text(_line(HASH_A, pad=150_000))
    assert get_last_hash(str(p)) == HASH_A


def test_long_trailing_whitespace_does_not_hide_the_last_line(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_text(_line(HASH_A) + "\n" + _line(HASH_B) + "\n" + " \n" * 100_000)
    assert get_last_hash(str(p)) == HASH_B


def test_long_whitespace_only_file_starts_a_new_chain(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_text("\n" * 200_000)
    assert get_last_hash(str(p)) == GENESIS_HASH


def test_unreadable_ledger_path_raises_a_ledger_error(tmp_path):
    d = tmp_path / "e.jsonl"
    d.mkdir()
    with pytest.raises(EvidenceLedgerError, match="Cannot read the evidence log"):
        get_last_hash(str(d))


# ---- whole ledger (through verify_evidence_ledger) ----

def test_verify_reports_an_unreadable_ledger(tmp_path):
    d = tmp_path / "e.jsonl"
    d.mkdir()
    res = verify_evidence_ledger(str(d))
    assert res["valid"] is False
    assert res["total"] == 0
    assert "Cannot read the evidence log" in res["error"]


def test_verify_skips_blank_lines_when_counting(tmp_path):
    p = tmp_path / "e.jsonl"
    log_evidence({"type": "one"}, str(p))
    log_evidence({"type": "two"}, str(p))
    text = p.read_text()
    p.write_text("\n \n" + text.replace("\n", "\n\n  \n"))
    res = verify_evidence_ledger(str(p))
    assert res["valid"] is True
    assert res["total"] == 2


def test_verify_names_the_line_with_invalid_utf8(tmp_path):
    p = tmp_path / "e.jsonl"
    log_evidence({"type": "one"}, str(p))
    with open(p, "ab") as f:
        f.write(b"\n\n\xff\xfe broken\n")
    res = verify_evidence_ledger(str(p))
    assert res["valid"] is False
    assert res["broken_index"] == 1
    assert "Invalid UTF-8 bytes at line 2" in res["error"]


def test_verify_reports_the_first_invalid_utf8_line(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_bytes(b"\xc3\x28\n\xff\n")
    res = verify_evidence_ledger(str(p))
    assert res["broken_index"] == 0
    assert res["total"] == 2
    assert "line 1" in res["error"]


# ---- leftovers of broken stale locks (through log_evidence) ----

def _make_stale_lock(path):
    lock = str(path) + ".lock"
    with open(lock, "w") as f:
        f.write("1:crashed")
    old = time.time() - 3600
    os.utime(lock, (old, old))
    return lock


def _touch(path, age):
    path.write_text("x")
    t = time.time() - age
    os.utime(path, (t, t))


def test_breaking_a_stale_lock_removes_old_leftovers_and_keeps_the_rest(tmp_path):
    p = tmp_path / "e.jsonl"
    old = tmp_path / "e.jsonl.lock.stale-1-dead"
    fresh = tmp_path / "e.jsonl.lock.stale-2-live"
    other = tmp_path / "other.lock.stale-3-old"
    unrelated = tmp_path / "notes.txt"
    _touch(old, 3600)
    _touch(fresh, 0)
    _touch(other, 3600)
    _touch(unrelated, 3600)
    _make_stale_lock(p)
    assert log_evidence({"type": "x"}, str(p)) is not None
    assert not old.exists()
    assert fresh.exists()
    assert other.exists()
    assert unrelated.exists()


def test_sweep_looks_at_no_more_than_five_leftovers(tmp_path):
    p = tmp_path / "e.jsonl"
    for i in range(8):
        _touch(tmp_path / f"e.jsonl.lock.stale-{i}-dead", 3600)
    _make_stale_lock(p)
    assert log_evidence({"type": "x"}, str(p)) is not None
    left = [n for n in os.listdir(tmp_path) if ".lock.stale-" in n]
    assert len(left) == 3


def test_sweep_ignores_a_missing_directory(tmp_path):
    evidence._sweep_stale_leftovers(str(tmp_path / "missing" / "e.jsonl.lock"))


def test_sweep_ignores_a_leftover_that_cannot_be_removed(tmp_path, monkeypatch):
    lock = str(tmp_path / "e.jsonl.lock")
    first = tmp_path / "e.jsonl.lock.stale-1-dead"
    _touch(first, 3600)

    def refuse(path):
        raise PermissionError("refused")

    monkeypatch.setattr(evidence.os, "unlink", refuse)
    evidence._sweep_stale_leftovers(lock)
    assert first.exists()
