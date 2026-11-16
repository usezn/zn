"""verify tells a last line that was cut off apart from a hash mismatch.

A cut-off last line is named as incomplete and explained; a manipulated record is still a tamper.
Mirrors packages/zn-gate/test/evidence_verify_truncated_tail.test.js.
"""

import argparse
from unittest import mock

from zn_gate import cli
from zn_gate.evidence import log_evidence, verify_evidence_ledger

INCOMPLETE = "Last record is incomplete (the write was cut off, for example by a crash or a full disk)"


def _ledger(tmp_path, n=3):
    p = str(tmp_path / "evidence.jsonl")
    for i in range(n):
        log_evidence({"payload": f"example-{i}", "tool_name": "bash"}, file_path=p)
    return p


def _read_bytes(p):
    with open(p, "rb") as f:
        return f.read()


def _write_bytes(p, data):
    with open(p, "wb") as f:
        f.write(data)


def test_cut_off_last_line_is_reported_as_incomplete(tmp_path):
    p = _ledger(tmp_path)
    data = _read_bytes(p)
    _write_bytes(p, data[: len(data) - 40])
    res = verify_evidence_ledger(p)
    assert res["valid"] is False
    assert res["truncated_tail"] is True
    assert res["verified"] == 2
    assert res["broken_index"] == 2
    assert INCOMPLETE in res["error"]
    assert "at line 3" in res["error"]
    assert "Tamper" not in res["error"]


def test_manipulated_record_in_the_middle_is_still_tamper(tmp_path):
    p = _ledger(tmp_path)
    text = _read_bytes(p).decode("utf-8")
    _write_bytes(p, text.replace("example-1", "example-X").encode("utf-8"))
    res = verify_evidence_ledger(p)
    assert res["valid"] is False
    assert "truncated_tail" not in res
    assert res["broken_index"] == 1
    assert "Tamper detected at line 2" in res["error"]


def test_manipulated_record_before_a_cut_off_last_line_is_tamper_first(tmp_path):
    p = _ledger(tmp_path)
    text = _read_bytes(p).decode("utf-8").replace("example-0", "example-X")
    _write_bytes(p, text.encode("utf-8")[:-40])
    res = verify_evidence_ledger(p)
    assert res["valid"] is False
    assert "truncated_tail" not in res
    assert res["broken_index"] == 0
    assert "Tamper detected at line 1" in res["error"]


def test_intact_ledger_verifies_without_truncation_flag(tmp_path):
    p = _ledger(tmp_path)
    assert verify_evidence_ledger(p) == {"valid": True, "total": 3, "verified": 3, "broken_index": None, "error": None}


def test_cli_prints_the_incomplete_explanation_and_exits_1(capsys):
    res = {
        "valid": False,
        "total": 3,
        "verified": 2,
        "broken_index": 2,
        "error": INCOMPLETE + " at line 3: the line is not valid JSON.",
        "truncated_tail": True,
    }
    with mock.patch.object(cli, "verify_evidence_ledger", return_value=res):
        assert cli.cmd_evidence(argparse.Namespace(verify=True)) == 1
    err = capsys.readouterr().err
    assert "LAST RECORD INCOMPLETE (NOT VERIFIED)" in err
    assert "Tamper" not in err
    assert "The first 2 records verified; the last line was cut off." in err
    assert "move it aside" in err


def test_cli_still_reports_tamper_for_hash_mismatch(capsys):
    res = {"valid": False, "total": 3, "verified": 1, "broken_index": 1, "error": "Tamper detected at line 2 (record x): hash mismatch! Log contents were modified."}
    with mock.patch.object(cli, "verify_evidence_ledger", return_value=res):
        assert cli.cmd_evidence(argparse.Namespace(verify=True)) == 1
    err = capsys.readouterr().err
    assert "Tamper detected:" in err
    assert "INCOMPLETE" not in err


def _tail_case(tmp_path, mutate, incomplete):
    p = _ledger(tmp_path)
    mutate(p)
    res = verify_evidence_ledger(p)
    assert res["valid"] is False
    if incomplete:
        assert res["truncated_tail"] is True
        assert INCOMPLETE in res["error"]
    else:
        assert "truncated_tail" not in res
        assert INCOMPLETE not in res["error"]


def _last_start(text):
    return text[:-1].rfind("\n") + 1


def _append(p, s):
    _write_bytes(p, _read_bytes(p) + s.encode("utf-8"))


def test_garbage_with_trailing_newline_is_tamper(tmp_path):
    _tail_case(tmp_path, lambda p: _append(p, "garbage\n"), False)


def test_fake_unfinished_record_with_trailing_newline_is_tamper(tmp_path):
    _tail_case(tmp_path, lambda p: _append(p, '{"id":"ev_fake","timestamp":"20\n'), False)


def test_cut_off_record_that_ends_with_newline_is_tamper(tmp_path):
    def m(p):
        t = _read_bytes(p).decode("utf-8")
        _write_bytes(p, (t[:-41] + "\n").encode("utf-8"))
    _tail_case(tmp_path, m, False)


def test_last_record_edited_valid_json_is_tamper(tmp_path):
    def m(p):
        t = _read_bytes(p).decode("utf-8")
        i = _last_start(t)
        _write_bytes(p, (t[:i] + t[i:].replace("example-2", "example-X")).encode("utf-8"))
    _tail_case(tmp_path, m, False)


def test_last_record_edited_invalid_json_is_tamper(tmp_path):
    def m(p):
        t = _read_bytes(p).decode("utf-8")
        _write_bytes(p, t.replace("example-2", 'example-2"{').encode("utf-8"))
    _tail_case(tmp_path, m, False)


def test_non_record_text_without_newline_is_tamper(tmp_path):
    _tail_case(tmp_path, lambda p: _append(p, "garbage"), False)


def test_invalid_json_not_starting_like_a_record_without_newline_is_tamper(tmp_path):
    def m(p):
        t = _read_bytes(p).decode("utf-8")
        _write_bytes(p, (t[:_last_start(t)] + '{"foo":"bar').encode("utf-8"))
    _tail_case(tmp_path, m, False)


def test_genuine_cut_is_still_incomplete(tmp_path):
    def m(p):
        t = _read_bytes(p)
        _write_bytes(p, t[:-60])
    _tail_case(tmp_path, m, True)
