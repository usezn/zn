"""zn-gate reach --history argument handling, output and failure exit codes, plus the
file reader's long-line and directory-walk limits (reach_history.run and helpers)."""
import json

import pytest

from zn_gate import reach_history as rh


@pytest.fixture(autouse=True)
def _keep_stats_env(monkeypatch):
    # run() switches ZN_STATS off for the history scan; this makes monkeypatch restore the original value
    # after each test so the change does not leak into other modules.
    monkeypatch.setenv("ZN_STATS", "on")


@pytest.fixture
def fake_history(monkeypatch):
    calls = {}

    def fake(**kwargs):
        calls.update(kwargs)
        return {"totals": {"files": 0}, "incomplete": [], "notes": []}

    monkeypatch.setattr(rh, "history", fake)
    return calls


@pytest.fixture
def fake_report(monkeypatch):
    seen = []
    monkeypatch.setattr(rh, "report", lambda r: seen.append(r) or 0)
    return seen


def _usage_error(capsys, args, expected):
    assert rh.run(args) == 2
    err = capsys.readouterr().err
    assert err.startswith("zn-gate reach: ")
    assert expected in err
    assert rh.REACH_USAGE in err


def test_help_prints_usage_and_exits_zero(capsys):
    assert rh.run(["--help"]) == 0
    out = capsys.readouterr().out
    assert rh.REACH_USAGE in out
    assert "Read only: nothing is changed or sent." in out


def test_short_help_flag_is_the_same(capsys):
    assert rh.run(["-h"]) == 0
    assert rh.REACH_USAGE in capsys.readouterr().out


def test_no_arguments_asks_for_history(capsys):
    _usage_error(capsys, [], "only --history is in the Python package")


@pytest.mark.parametrize("value", ["0", "3601", "12345", "x", "-3", "1.5"])
def test_max_seconds_out_of_range_or_malformed_is_a_usage_error(capsys, value):
    _usage_error(capsys, ["--history", "--max-seconds=" + value], "--max-seconds must be a whole number from 1 to 3600")


def test_max_seconds_without_a_value_is_a_usage_error(capsys):
    _usage_error(capsys, ["--history", "--max-seconds"], "--max-seconds must be a whole number")


def test_max_seconds_goes_only_with_history(capsys):
    _usage_error(capsys, ["--max-seconds=5"], "--max-seconds goes with --history")
    _usage_error(capsys, ["--max-seconds", "5"], "--max-seconds goes with --history")


def test_json_and_sarif_cannot_be_combined(capsys):
    _usage_error(capsys, ["--history", "--json", "--sarif"], "choose one of --json and --sarif")
    _usage_error(capsys, ["--history", "--sarif", "--json"], "choose one of --json and --sarif")


@pytest.mark.parametrize("args", [["--history", "--fail-on=bogus"], ["--history", "--fail-on"]])
def test_fail_on_rejects_unknown_or_missing_values(capsys, args):
    _usage_error(capsys, args, "--fail-on must be one of high, medium, low, none")


def test_unknown_option_is_named(capsys):
    _usage_error(capsys, ["--wat"], "unknown option --wat")


def test_only_one_folder_at_a_time(capsys):
    _usage_error(capsys, ["one", "two"], "only one folder at a time")


def test_history_refuses_folder_and_other_report_flags(capsys):
    refused = "--history reads your home folder: it takes only --json and --max-seconds"
    _usage_error(capsys, ["--history", "somefolder"], refused)
    _usage_error(capsys, ["--history", "--remember"], refused)
    _usage_error(capsys, ["--history", "--sarif"], refused)
    _usage_error(capsys, ["--history", "--fail-on=high"], refused)
    _usage_error(capsys, ["--history", "--fail-on=HIGH"], refused)


def test_history_json_output_and_max_seconds_are_passed_through(capsys, fake_history, fake_report, monkeypatch):
    assert rh.run(["--history", "--json", "--max-seconds", "7"]) == 0
    assert fake_history == {"max_seconds": 7}
    assert fake_report == []
    printed = json.loads(capsys.readouterr().out)
    assert printed == {"totals": {"files": 0}, "incomplete": [], "notes": []}
    assert rh.os.environ["ZN_STATS"] == "off"


def test_history_text_output_uses_the_report(fake_history, fake_report):
    assert rh.run(["--history", "--max-seconds=12"]) == 0
    assert fake_history == {"max_seconds": 12}
    assert len(fake_report) == 1
    assert fake_report[0]["totals"] == {"files": 0}


def test_history_failure_exits_two_with_the_reason(capsys, monkeypatch, fake_report):
    def broken(**kwargs):
        raise RuntimeError("boom while reading history")

    monkeypatch.setattr(rh, "history", broken)
    assert rh.run(["--history"]) == 2
    assert "zn-gate reach: could not finish: boom while reading history" in capsys.readouterr().err
    assert fake_report == []


def test_history_failure_message_is_capped(capsys, monkeypatch):
    def broken(**kwargs):
        raise RuntimeError("x" * 1000)

    monkeypatch.setattr(rh, "history", broken)
    assert rh.run(["--history"]) == 2
    line = capsys.readouterr().err.splitlines()[0]
    assert len(line) <= len("zn-gate reach: could not finish: ") + 300


# Helpers below the run() entry point: the walk limits and the line-length guard.

def test_walk_skips_directories_deeper_than_the_limit(tmp_path):
    out, skipped = [], []
    rh._walk(str(tmp_path), ".json", rh.MAX_DEPTH + 1, out, skipped, {"id": "a"}, str(tmp_path), 5)
    assert out == []
    assert skipped == [{"agent": "a", "file": rh.display(str(tmp_path), str(tmp_path)), "reason": "too-deep", "limit": rh.MAX_DEPTH}]


def test_walk_stops_when_the_file_cap_is_reached(tmp_path):
    out, skipped = [{}, {}], []
    rh._walk(str(tmp_path), ".json", 0, out, skipped, {"id": "a"}, str(tmp_path), 2)
    assert len(out) == 2
    assert skipped[0]["reason"] == "too-many-files"
    assert skipped[0]["limit"] == 2


def test_walk_ignores_a_directory_it_cannot_list(tmp_path):
    out, skipped = [], []
    rh._walk(str(tmp_path / "missing"), ".json", 0, out, skipped, {"id": "a"}, str(tmp_path), 5)
    assert out == [] and skipped == []


def test_scan_file_reports_a_line_longer_than_the_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(rh, "MAX_LINE_BYTES", 8)
    p = tmp_path / "long.txt"
    p.write_bytes(b"x" * 20 + b"\nok\n")
    r = rh.scan_file(str(p), float("inf"))
    assert r["complete"] is False
    assert r["reason"] == "line-too-long"
    assert r["bytes"] == len(b"x" * 20 + b"\nok\n")


def test_scan_file_drops_a_long_unterminated_tail(tmp_path, monkeypatch):
    monkeypatch.setattr(rh, "MAX_LINE_BYTES", 8)
    p = tmp_path / "tail.txt"
    p.write_bytes(b"ok\n" + b"y" * 20)
    r = rh.scan_file(str(p), float("inf"))
    assert r["complete"] is False
    assert r["reason"] == "line-too-long"


def test_scan_file_recovers_after_a_dropped_line(tmp_path, monkeypatch):
    monkeypatch.setattr(rh, "MAX_LINE_BYTES", 8)
    p = tmp_path / "recover.txt"
    p.write_bytes(b"y" * 20 + b"\nz\n")
    r = rh.scan_file(str(p), float("inf"))
    assert r["reason"] == "line-too-long"
    assert r["bytes"] == len(b"y" * 20 + b"\nz\n")


def test_scan_file_reads_a_short_unterminated_last_line(tmp_path):
    p = tmp_path / "short.txt"
    p.write_bytes(b"abc")
    r = rh.scan_file(str(p), float("inf"))
    assert r == {"counts": {}, "bytes": 3, "complete": True, "reason": None}


def test_scan_file_reports_an_unexpected_read_failure(tmp_path, monkeypatch):
    p = tmp_path / "boom.txt"
    p.write_bytes(b"abc\n")

    def broken_read(fd, size):
        raise RuntimeError("disk gone")

    monkeypatch.setattr(rh.os, "read", broken_read)
    r = rh.scan_file(str(p), float("inf"))
    assert r["complete"] is False
    assert r["reason"] == "unreadable"


def test_scan_file_ignores_a_failure_to_close_the_descriptor(tmp_path, monkeypatch):
    p = tmp_path / "close.txt"
    p.write_bytes(b"abc\n")
    real_close = rh.os.close

    def close_then_fail(fd):
        real_close(fd)
        raise OSError("close failed")

    monkeypatch.setattr(rh.os, "close", close_then_fail)
    r = rh.scan_file(str(p), float("inf"))
    assert r == {"counts": {}, "bytes": 4, "complete": True, "reason": None}
