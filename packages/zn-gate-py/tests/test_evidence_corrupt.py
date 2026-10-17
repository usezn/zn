"""A ledger with invalid bytes or a broken line is reported as corrupted, never as a crash,
and never lets the next write silently restart the hash chain."""
import os

import pytest

from zn_gate import cli, evidence
from zn_gate.evidence import (
    GENESIS_HASH,
    EvidenceLedgerError,
    export_evidence_ledger,
    get_evidence_stats,
    get_last_hash,
    log_evidence,
    verify_evidence_ledger,
)


@pytest.fixture(autouse=True)
def _reset_warning(monkeypatch):
    monkeypatch.setattr(evidence, "_last_warn", None)


def _ledger(tmp_path, n=2):
    p = str(tmp_path / "evidence.jsonl")
    for i in range(n):
        log_evidence({"payload": f"example-{i}", "tool_name": "bash"}, file_path=p)
    return p


def _append(p, data: bytes):
    with open(p, "ab") as f:
        f.write(data)


def _corrupt_end(tmp_path):
    p = _ledger(tmp_path)
    _append(p, b"\xff\xfe\x80garbage\n")
    return p, 3


def _corrupt_middle(tmp_path):
    p = _ledger(tmp_path, n=3)
    with open(p, "rb") as f:
        lines = f.read().split(b"\n")
    lines[1] = lines[1][:20] + b"\xff\xfe" + lines[1][20:]
    with open(p, "wb") as f:
        f.write(b"\n".join(lines))
    return p, 2


def _truncated_last(tmp_path):
    p = _ledger(tmp_path)
    with open(p, "rb") as f:
        data = f.read()
    with open(p, "wb") as f:
        f.write(data[: len(data) - 40])
    return p, 2


CORRUPT = [_corrupt_end, _corrupt_middle, _truncated_last]
# get_last_hash and log_evidence read only the end of the file: they refuse on damage to the
# last line. Damage earlier in the file is found by verify.
TAIL_CORRUPT = [_corrupt_end, _truncated_last]


def test_valid_log_still_verifies(tmp_path):
    p = _ledger(tmp_path, n=3)
    assert verify_evidence_ledger(p)["valid"] is True
    assert get_evidence_stats(p)["valid"] is True
    assert export_evidence_ledger(p)["valid"] is True
    assert len(get_last_hash(p)) == 64 and get_last_hash(p) != GENESIS_HASH


def test_empty_and_missing_file_are_genesis(tmp_path):
    missing = str(tmp_path / "nope.jsonl")
    assert get_last_hash(missing) == GENESIS_HASH
    empty = str(tmp_path / "empty.jsonl")
    open(empty, "wb").close()
    assert get_last_hash(empty) == GENESIS_HASH
    assert verify_evidence_ledger(empty)["valid"] is True
    rec = log_evidence({"payload": "x"}, file_path=empty)
    assert rec["prev_hash"] == GENESIS_HASH


@pytest.mark.parametrize("make", CORRUPT)
def test_verify_reports_corruption_with_line(tmp_path, make):
    p, line = make(tmp_path)
    res = verify_evidence_ledger(p)
    assert res["valid"] is False
    assert res["error"]
    assert f"line {line}" in res["error"]
    assert res["broken_index"] == line - 1


def test_invalid_bytes_message_names_the_bytes(tmp_path):
    p, line = _corrupt_end(tmp_path)
    assert "Invalid UTF-8" in verify_evidence_ledger(p)["error"]


@pytest.mark.parametrize("make", CORRUPT)
def test_stats_and_export_do_not_crash(tmp_path, make):
    p, _ = make(tmp_path)
    stats = get_evidence_stats(p)
    assert stats["valid"] is False and stats["error"]
    for fmt in ("jsonl", "csv"):
        res = export_evidence_ledger(p, fmt)
        assert res["valid"] is False and res["error"]
        assert isinstance(res["content"], str)


@pytest.mark.parametrize("make", TAIL_CORRUPT)
def test_get_last_hash_fails_closed(tmp_path, make):
    p, _ = make(tmp_path)
    with pytest.raises(EvidenceLedgerError):
        get_last_hash(p)


@pytest.mark.parametrize("make", TAIL_CORRUPT)
def test_log_evidence_refuses_to_append_and_warns_once(tmp_path, make, capsys):
    p, _ = make(tmp_path)
    before = open(p, "rb").read()
    assert log_evidence({"payload": "after"}, file_path=p) is None
    assert log_evidence({"payload": "again"}, file_path=p) is None
    assert open(p, "rb").read() == before  # nothing appended, chain not restarted
    err = capsys.readouterr().err
    assert err.count("is damaged") == 1
    assert "--verify" in err
    assert "evidence.damaged.jsonl" in err  # tells the user how to recover


def test_unreadable_log_fails_closed(tmp_path, monkeypatch, capsys):
    p = _ledger(tmp_path)
    real_open = open

    def fake_open(path, mode="r", *a, **k):
        if str(path) == p and "b" in mode and "r" in mode:
            raise PermissionError(13, "Permission denied")
        return real_open(path, mode, *a, **k)

    monkeypatch.setattr("builtins.open", fake_open)
    assert log_evidence({"payload": "x"}, file_path=p) is None
    assert verify_evidence_ledger(p)["valid"] is False
    assert "damaged" in capsys.readouterr().err


def test_cli_verify_reports_tamper_and_exits_nonzero(tmp_path, monkeypatch, capsys):
    p, _ = _corrupt_end(tmp_path)
    monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: verify_evidence_ledger(p))
    code = cli.cmd_evidence(type("A", (), {"verify": True})())
    assert code != 0
    assert "Tamper detected" in capsys.readouterr().err


def test_cli_stats_and_export_print_message_without_traceback(tmp_path, monkeypatch, capsys):
    p, _ = _corrupt_end(tmp_path)
    monkeypatch.setattr(cli, "get_evidence_stats", lambda: get_evidence_stats(p))
    monkeypatch.setattr(cli, "export_evidence_ledger", lambda format="jsonl": export_evidence_ledger(p, format))
    cli.cmd_evidence(type("A", (), {})())
    out = capsys.readouterr().out
    assert "CORRUPTED" in out and "Invalid UTF-8" in out
    cli.cmd_evidence(type("A", (), {"export": True, "format": "jsonl", "output": None})())
    assert "Tamper detected" in capsys.readouterr().err


def test_damage_in_the_middle_is_found_by_verify_and_not_hidden_by_appending(tmp_path):
    p, line = _corrupt_middle(tmp_path)
    assert log_evidence({"payload": "after"}, file_path=p) is not None
    res = verify_evidence_ledger(p)
    assert res["valid"] is False and f"line {line}" in res["error"]


def test_huge_damaged_last_line_still_fails_closed(tmp_path):
    p = _ledger(tmp_path)
    _append(p, b"x" * 300_000)  # longer than the tail window, no newline
    with pytest.raises(EvidenceLedgerError):
        get_last_hash(p)


def test_last_hash_of_a_long_valid_log_is_the_last_record(tmp_path):
    p = str(tmp_path / "long.jsonl")
    last = None
    for i in range(300):
        last = log_evidence({"payload": f"example-{i}"}, file_path=p)
    assert get_last_hash(p) == last["record_hash"]


def test_warning_repeats_after_the_interval(tmp_path, monkeypatch, capsys):
    p, _ = _corrupt_end(tmp_path)
    now = [1000.0]
    monkeypatch.setattr(evidence.time, "monotonic", lambda: now[0])
    log_evidence({"payload": "a"}, file_path=p)
    now[0] += evidence.WARN_INTERVAL - 1
    log_evidence({"payload": "b"}, file_path=p)
    assert capsys.readouterr().err.count("is damaged") == 1
    now[0] += 2
    log_evidence({"payload": "c"}, file_path=p)
    assert capsys.readouterr().err.count("is damaged") == 1


@pytest.mark.parametrize("junk", [b"\xef\xbb\xbf", b"\xc2\xa0"], ids=["bom", "nbsp"])
@pytest.mark.parametrize("where", ["start", "end"])
def test_bom_and_nbsp_are_not_trimmed(tmp_path, junk, where):
    # Same result as the Node package: only space, tab and CR are trimmed around a line.
    p = _ledger(tmp_path)
    with open(p, "rb") as f:
        data = f.read()
    lines = data.split(b"\n")
    lines[0] = junk + lines[0] if where == "start" else lines[0] + junk
    with open(p, "wb") as f:
        f.write(b"\n".join(lines))
    res = verify_evidence_ledger(p)
    assert res["valid"] is False and "line 1" in res["error"]


def test_crlf_and_padding_with_ascii_whitespace_stay_valid(tmp_path):
    p = _ledger(tmp_path)
    with open(p, "rb") as f:
        data = f.read()
    with open(p, "wb") as f:
        f.write(data.replace(b"\n", b" \t\r\n"))
    assert verify_evidence_ledger(p)["valid"] is True
    assert len(get_last_hash(p)) == 64


def test_recovery_hint_names_the_move_and_the_cli_prints_it(tmp_path, monkeypatch, capsys):
    p, _ = _corrupt_end(tmp_path)
    assert "evidence.damaged.jsonl" in evidence.recovery_hint(p)
    monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: verify_evidence_ledger(p))
    monkeypatch.setattr(cli, "recovery_hint", lambda: evidence.recovery_hint(p))
    cli.cmd_evidence(type("A", (), {"verify": True})())
    assert "evidence.damaged.jsonl" in capsys.readouterr().err
