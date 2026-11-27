"""
Timesketch export helpers: the microsecond timestamps follow the same strict rules as the Node
package (no Date.UTC), and the JavaScript value rendering matches JSON.stringify and String().
Only invented values and temporary folders.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

from zn_gate import evidence as ev
from zn_gate import evidence_timesketch as ts

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _micros(dt):
    """Whole microseconds since the epoch, as the text the export writes."""
    return str((dt - EPOCH) // timedelta(microseconds=1))


# ------------------------------------------------------------------ timesketch_micros

def test_micros_strict_utc_iso_or_empty():
    assert ts.timesketch_micros("1970-01-01T00:00:00Z") == "0"
    base = datetime(2026, 11, 26, 19, 30, 0, tzinfo=timezone.utc)
    assert ts.timesketch_micros("2026-11-26T19:30:00.123Z") == str(int(_micros(base)) + 123000)
    assert ts.timesketch_micros("2026-11-26T19:30:00.123456Z") == str(int(_micros(base)) + 123456)
    assert ts.timesketch_micros("2026-11-26 19:30:00") == ""
    assert ts.timesketch_micros("2026-11-26T19:30:00+01:00") == ""
    assert ts.timesketch_micros(None) == ""
    assert ts.timesketch_micros(42) == ""


def test_micros_rejects_trailing_newline_and_non_ascii_digits():
    assert ts.timesketch_micros("1970-01-01T00:00:00Z\n") == ""
    assert ts.timesketch_micros("١970-01-01T00:00:00Z") == ""


def test_micros_nonexistent_dates_are_empty_and_odd_years_keep_their_value():
    for bad in [
        "2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "1900-02-29T00:00:00Z",
        "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-04-31T00:00:00Z",
        "2026-01-00T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z",
        "2026-12-31T23:59:60Z",
    ]:
        assert ts.timesketch_micros(bad) == "", bad
    assert ts.timesketch_micros("2024-02-29T12:00:00Z") == _micros(datetime(2024, 2, 29, 12, tzinfo=timezone.utc))
    assert ts.timesketch_micros("2000-02-29T00:00:00Z") == _micros(datetime(2000, 2, 29, tzinfo=timezone.utc))
    assert ts.timesketch_micros("1969-12-31T23:59:59.999999Z") == "-1"
    # Year 0050 stays 0050 (not 1950, as Date.UTC would make it).
    assert ts.timesketch_micros("0050-01-01T00:00:00Z") == _micros(datetime(50, 1, 1, tzinfo=timezone.utc))
    # Year 0000 is a leap year; 0000-03-01 is 366 days before 0001-03-01.
    # datetime cannot hold year 0, so the expected value is computed from 0001-03-01: from 0000-03-01
    # to 0001-03-01 is 365 days (the leap day of year 0 comes before March).
    year1_micros = int(_micros(datetime(1, 3, 1, tzinfo=timezone.utc)))
    assert ts.timesketch_micros("0000-03-01T00:00:00Z") == str(year1_micros - 365 * 86400 * 1000000)
    assert ts.timesketch_micros("9999-12-31T23:59:59Z") == _micros(datetime(9999, 12, 31, 23, 59, 59, tzinfo=timezone.utc))


# ------------------------------------------------------------------ JavaScript rendering

@pytest.mark.parametrize("value, text", [
    (0.00001, "0.00001"),
    (1e-7, "1e-7"),
    (0.000123, "0.000123"),
    (1e20, "100000000000000000000"),
    (1e21, "1e+21"),
    (12.0, "12"),
    (12.7, "12.7"),
    (-0.0, "0"),
    (0.0, "0"),
    (float("inf"), "Infinity"),
    (True, "true"),
    (False, "false"),
    (None, ""),
    ("", ""),
])
def test_plain_text_is_string_of_javascript_value(value, text):
    assert ts._plain(value) == text


@pytest.mark.parametrize("value, text", [
    (float("inf"), "null"),
    (12.0, "12"),
    (1e-7, "1e-7"),
    (None, "null"),
    (True, "true"),
    ("x\u0001\u007fé", '"x\\u0001\x7fé"'),
    ("q\"b\\n\n\t\b\f\r", '"q\\"b\\\\n\\n\\t\\b\\f\\r"'),
    ("\ud800", '"\\ud800"'),
])
def test_json_value_is_json_stringify(value, text):
    assert ts._json_js(value) == text


def test_json_object_orders_index_keys_first_like_javascript():
    obj = {"b": 1, "2": "n", "a": [1.0, True, None], "1": "m"}
    assert ts._json_js(obj) == '{"1":"m","2":"n","b":1,"a":[1,true,null]}'


def test_parsed_integers_past_two_to_the_53_are_doubles():
    rec, err = ts._parse_record('{"n": 9007199254740993, "m": -0, "k": 1.0}')
    assert err is None
    assert ts._json_js(rec) == '{"n":9007199254740992,"m":0,"k":1}'


@pytest.mark.parametrize("text", ["NaN", '{"a": Infinity}', '{"a": -Infinity}', '{"a": 1,}'])
def test_js_rejects_what_json_parse_rejects(text):
    rec, err = ts._parse_record(text)
    assert err is not None


def test_csv_cell_doubles_quotes_and_keeps_newlines():
    rec = {"verdict": 'say "hi"\nnow', "tool_name": "tüñ", "agent_environment": "a", "timestamp": "x"}
    line = ts._event_line("timesketch-csv", rec, 0, True)
    first_cell = '"' + 'say ""hi""\nnow tüñ by a' + '"'
    assert line.startswith(first_cell + ",")
    assert line.endswith(',"0","true"')


# ------------------------------------------------------------------ export_timesketch

def _ledger(tmp_path, records):
    p = tmp_path / "evidence.jsonl"
    for r in records:
        ev.log_evidence(r, str(p))
    return p


def test_missing_ledger_gives_header_only_for_csv(tmp_path):
    missing = str(tmp_path / "none.jsonl")
    assert ts.export_timesketch(missing, "timesketch")["content"] == ""
    res = ts.export_timesketch(missing, "timesketch-csv")
    assert res["content"] == ts.TIMESKETCH_CSV_HEADER_LINE + "\n"
    assert res["valid"] is True and res["total"] == 0


def test_event_message_and_no_payload_preview(tmp_path):
    p = _ledger(tmp_path, [{"verdict": "block", "tool_name": "shell", "agent_environment": "agent-a",
                            "rule": "zn_state", "payload": "secret words the agent wrote"}])
    res = ts.export_timesketch(str(p), "timesketch")
    event = json.loads(res["content"].splitlines()[0])
    assert event["message"] == "block shell by agent-a (rule zn_state)"
    assert event["timestamp_desc"] == ts.TIMESKETCH_DESC
    assert event["zn_chain_verified"] is True and event["zn_chain_index"] == 0
    assert "secret words" not in res["content"]
    assert "payload_preview" not in event


def test_records_from_first_break_are_unverified(tmp_path):
    p = _ledger(tmp_path, [{"verdict": "allow", "tool_name": "a"}, {"verdict": "allow", "tool_name": "b"},
                           {"verdict": "allow", "tool_name": "c"}])
    lines = p.read_text(encoding="utf-8").splitlines()
    lines[1] = lines[1].replace('"allow"', '"block"', 1)
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    res = ts.export_timesketch(str(p), "timesketch")
    flags = [json.loads(x)["zn_chain_verified"] for x in res["content"].splitlines()]
    assert flags == [True, False, False]
    assert res["valid"] is False and "Tamper" in res["error"]


def test_cut_off_last_line_gives_no_event(tmp_path):
    p = _ledger(tmp_path, [{"verdict": "allow", "tool_name": "a"}])
    with open(p, "ab") as f:
        f.write(b'{"id":"ev_partial')
    res = ts.export_timesketch(str(p), "timesketch")
    assert len(res["content"].splitlines()) == 1
    assert res["valid"] is False and res.get("truncated_tail") is True


def test_csv_export_row_count_matches_events(tmp_path):
    p = _ledger(tmp_path, [{"verdict": "allow", "tool_name": "a"}, {"verdict": "block", "tool_name": "b"}])
    res = ts.export_timesketch(str(p), "timesketch-csv")
    rows = res["content"].split("\n")
    assert rows[0] == ts.TIMESKETCH_CSV_HEADER_LINE
    assert rows[-1] == ""
    assert len(rows) - 2 == 2
    assert rows[1].startswith('"allow a by ')


@pytest.mark.parametrize("fmt, first_line", [
    ("timesketch-csv", ts.TIMESKETCH_CSV_HEADER_LINE),
    ("TIMESKETCH", ""),
])
def test_cli_export_accepts_timesketch_formats(tmp_path, fmt, first_line):
    import os
    import subprocess
    import sys

    src = os.path.join(os.path.dirname(ts.__file__), "..")
    env = {**os.environ, "ZN_HOME": str(tmp_path), "PYTHONPATH": os.path.abspath(src)}
    proc = subprocess.run(
        [sys.executable, "-m", "zn_gate", "evidence", "--export", "--format", fmt],
        capture_output=True, text=True, env=env, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.split("\n")[0] == first_line


def test_cli_export_rejects_unknown_format(tmp_path):
    import os
    import subprocess
    import sys

    src = os.path.join(os.path.dirname(ts.__file__), "..")
    env = {**os.environ, "ZN_HOME": str(tmp_path), "PYTHONPATH": os.path.abspath(src)}
    proc = subprocess.run(
        [sys.executable, "-m", "zn_gate", "evidence", "--export", "--format", "xlsx"],
        capture_output=True, text=True, env=env, timeout=120,
    )
    assert proc.returncode == 2
    assert "timesketch-csv" in proc.stderr
