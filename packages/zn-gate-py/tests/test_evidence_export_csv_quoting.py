"""evidence --export csv quotes every field, so a comma, a line break or a double
quote inside a value survives a round trip through the standard csv reader.
Only temporary directories and invented values."""
import csv
import io

from zn_gate.evidence import export_evidence_ledger, log_evidence

TOOL = "example,tool"
REASON = 'blocked, example rule\nsecond line with "quotes"'


def test_csv_export_round_trips_commas_newlines_and_quotes(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("ZN_HOME", str(tmp_path / "zn-home"))
    ledger = tmp_path / "evidence.jsonl"
    rec = log_evidence({"verdict": "block", "phase": "pre", "tool_name": TOOL, "reason": REASON},
                       file_path=str(ledger))
    assert rec is not None

    result = export_evidence_ledger(str(ledger), format="csv")
    assert result["format"] == "csv"
    rows = list(csv.reader(io.StringIO(result["content"], newline="")))
    assert len(rows) == 2
    header, row = rows
    assert len(row) == len(header) == 11
    record = dict(zip(header, row, strict=True))
    assert record["tool_name"] == TOOL
    assert record["reason"] == REASON
