"""A ledger whose last record has no final newline (an editor, a cut-off write) must not get
the next record glued onto that line: the next record starts its own line."""
import json

from zn_gate.evidence import log_evidence, verify_evidence_ledger


def _event(n):
    return {"payload": f"example-{n}", "tool_name": "bash"}


def _read(p):
    with open(p, "rb") as f:
        return f.read()


def test_record_appended_without_final_newline_starts_its_own_line(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    log_evidence(_event(0), file_path=p)
    log_evidence(_event(1), file_path=p)
    data = _read(p)
    assert data.endswith(b"\n")
    with open(p, "wb") as f:
        f.write(data[:-1])  # drop the final newline, as an editor might
    rec = log_evidence(_event(2), file_path=p)
    assert rec is not None
    lines = _read(p).split(b"\n")
    assert len(lines) == 4 and lines[3] == b""  # three records, each on its own line
    assert json.loads(lines[2])["record_hash"] == rec["record_hash"]
    assert verify_evidence_ledger(p)["valid"] is True


def test_normal_ledger_gets_no_extra_empty_line(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    for i in range(3):
        log_evidence(_event(i), file_path=p)
    data = _read(p)
    assert b"\n\n" not in data
    assert len(data.split(b"\n")) == 4
    assert verify_evidence_ledger(p)["valid"] is True


def test_empty_ledger_gets_exactly_one_record_line(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    with open(p, "wb"):
        pass
    assert log_evidence(_event(0), file_path=p) is not None
    data = _read(p)
    assert data.startswith(b"{") and len(data.split(b"\n")) == 2
    assert verify_evidence_ledger(p)["valid"] is True


def test_missing_ledger_gets_one_record_line(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    assert log_evidence(_event(0), file_path=p) is not None
    assert len(_read(p).split(b"\n")) == 2
    assert verify_evidence_ledger(p)["valid"] is True


def test_ledger_already_joined_into_one_line_is_reported_and_writer_fails_closed(tmp_path):
    p = str(tmp_path / "evidence.jsonl")
    log_evidence(_event(0), file_path=p)
    log_evidence(_event(1), file_path=p)
    lines = [ln for ln in _read(p).split(b"\n") if ln]
    # The damage the old writer left behind: two records on one line.
    with open(p, "wb") as f:
        f.write(lines[0] + lines[1] + b"\n")
    res = verify_evidence_ledger(p)
    assert res["valid"] is False and "line 1" in res["error"]
    assert log_evidence(_event(2), file_path=p) is None
    assert len(_read(p).split(b"\n")) == 2  # nothing was appended
