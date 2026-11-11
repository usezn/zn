"""The tip anchor: evidence.tip next to the log, written after each append, checked by verify.
Fake values only; every test uses its own folder."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from zn_gate import cli
from zn_gate import evidence as ev

NODE = shutil.which("node")
EVIDENCE_JS = Path(__file__).resolve().parents[2] / "zn-gate" / "lib" / "evidence.js"


def append(file: Path, n: int, label: str = "e"):
    out = []
    for i in range(n):
        rec = ev.log_evidence({"agent": "test-agent", "tool_name": "bash", "payload": f"{label}-{i}"}, str(file))
        assert rec, "append must succeed"
        out.append(rec)
    return out


def lines(file: Path):
    return [ln for ln in file.read_text(encoding="utf-8").split("\n") if ln]


def cut_last(file: Path, n: int):
    ls = lines(file)
    file.write_text("\n".join(ls[: len(ls) - n]) + "\n", encoding="utf-8")


@pytest.fixture()
def led(tmp_path):
    file = tmp_path / "evidence.jsonl"
    return file, tmp_path / "evidence.tip"


def test_every_append_moves_the_tip(led):
    file, tip_file = led
    recs = append(file, 3)
    assert ev.tip_path_of(str(file)) == str(tip_file)
    tip = json.loads(tip_file.read_text())
    assert tip["v"] == 1 and tip["count"] == 3 and tip["tip_hash"] == recs[2]["record_hash"]
    append(file, 1, "more")
    assert ev.read_tip(str(file))["count"] == 4
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] and v["anchored"] and not v["truncated"] and v["tip"]["count"] == 4
    assert [p for p in os.listdir(file.parent) if ".tmp-" in p] == []


def test_truncated_one_and_many(led):
    file, _ = led
    append(file, 8)
    cut_last(file, 1)
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] is False and v["truncated"] is True
    assert v["error"] == "LOG TRUNCATED: 7 records found, the last tip expects at least 8"
    cut_last(file, 5)
    v = ev.verify_evidence_ledger(str(file))
    assert v["error"] == "LOG TRUNCATED: 2 records found, the last tip expects at least 8"


def test_missing_log_with_tip_is_truncated_without_tip_is_fine(led, tmp_path):
    file, _ = led
    append(file, 2)
    file.unlink()
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] is False and v["truncated"] is True and v["total"] == 0
    stats = ev.get_evidence_stats(str(file))
    assert stats["valid"] is False and stats["truncated"] is True
    exp = ev.export_evidence_ledger(str(file))
    assert exp["valid"] is False and exp["truncated"] is True
    fresh = ev.verify_evidence_ledger(str(tmp_path / "other" / "evidence.jsonl"))
    assert fresh["valid"] is True and fresh["anchored"] is False and fresh["tip"] is None


def test_no_tip_is_ok_and_not_anchored_and_verify_never_creates_it(led):
    file, tip_file = led
    append(file, 3)
    tip_file.unlink()
    cut_last(file, 1)
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] and v["anchored"] is False and v["truncated"] is False
    assert not tip_file.exists()


def test_edited_tip_truncated_or_rewritten(led):
    file, tip_file = led
    append(file, 4)
    tip = json.loads(tip_file.read_text())
    tip_file.write_text(json.dumps({**tip, "count": 9}))
    assert ev.verify_evidence_ledger(str(file))["truncated"] is True
    tip_file.write_text(json.dumps({**tip, "tip_hash": "a" * 64}))
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] is False and v["rewritten"] is True and v["truncated"] is False
    assert v["error"] == "LOG REWRITTEN: record 4 differs from the tip"


def test_replaced_by_another_valid_chain_is_rewritten(led, tmp_path):
    file, _ = led
    append(file, 4)
    other = tmp_path / "other" / "evidence.jsonl"
    append(other, 4, "other")
    assert ev.verify_evidence_ledger(str(other))["valid"]
    shutil.copyfile(other, file)
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] is False and v["rewritten"] is True


def test_records_after_the_tip_are_fine(led):
    file, tip_file = led
    recs = append(file, 5)
    tip_file.write_text(json.dumps({"v": 1, "count": 3, "tip_hash": recs[2]["record_hash"], "ts": "2026-01-01T00:00:00Z"}))
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] and v["anchored"] and v["total"] == 5


@pytest.mark.parametrize("bad", ["", "not json", '{"v":1}', '{"v":2,"count":1,"tip_hash":"' + "a" * 64 + '"}',
                                 '{"v":1,"count":-1,"tip_hash":"' + "a" * 64 + '"}'])
def test_malformed_tip_counts_as_no_tip(led, bad):
    file, tip_file = led
    append(file, 2)
    tip_file.write_text(bad)
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] and v["anchored"] is False


def test_migration_anchors_once(led):
    file, tip_file = led
    append(file, 3)
    tip_file.unlink()
    assert ev.read_tip(str(file)) is None
    append(file, 1, "after")
    assert ev.read_tip(str(file))["count"] == 4


def test_crash_lag_and_catch_up(led):
    file, tip_file = led
    recs = append(file, 4)
    tip_file.write_text(json.dumps({"v": 1, "count": 3, "tip_hash": recs[2]["record_hash"], "ts": "2026-01-01T00:00:00Z"}))
    assert ev.verify_evidence_ledger(str(file))["valid"]
    append(file, 1, "next")
    tip = ev.read_tip(str(file))
    assert tip["count"] == 5 and tip["tip_hash"] == json.loads(lines(file)[-1])["record_hash"]


def test_gap_from_an_older_writer_is_recovered_from_the_tail(led):
    file, tip_file = led
    append(file, 2)
    old = tip_file.read_text()
    append(file, 4, "gap")
    tip_file.write_text(old)
    assert ev.verify_evidence_ledger(str(file))["valid"]
    append(file, 1, "new")
    assert ev.read_tip(str(file))["count"] == 7


def test_diverged_tip_is_not_moved_and_warns_once(led, capfd):
    file, tip_file = led
    append(file, 5)
    before = tip_file.read_text()
    cut_last(file, 2)
    for _ in range(3):
        assert ev.log_evidence({"agent": "a", "tool_name": "bash", "payload": "x"}, str(file))
    assert len(lines(file)) == 3 + 3
    assert tip_file.read_text() == before
    v = ev.verify_evidence_ledger(str(file))
    # Three new records took the log past the tip's count, but record 5 is not the one the tip names.
    assert v["valid"] is False and v["rewritten"] is True
    assert capfd.readouterr().err.count("does not match its last tip") <= 1


def test_tip_write_failure_never_fails_the_append(tmp_path, capfd):
    file = tmp_path / "evidence.jsonl"
    (tmp_path / "evidence.tip").mkdir()
    (tmp_path / "evidence.tip" / "keep").write_text("x")
    assert ev.log_evidence({"agent": "a", "tool_name": "bash", "payload": "p"}, str(file))
    assert len(lines(file)) == 1
    assert "cannot update the evidence tip" in capfd.readouterr().err
    assert [p for p in os.listdir(tmp_path) if ".tmp-" in p] == []


def test_accept_refuses_without_a_terminal_and_changes_nothing(led, monkeypatch):
    file, tip_file = led
    append(file, 4)
    cut_last(file, 1)
    before = tip_file.read_text()
    for var in ev._AGENT_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    # pytest's stdin is not a terminal: the refusal is real, no terminal is simulated.
    assert not sys.stdin.isatty()
    with pytest.raises(PermissionError, match="interactive terminal"):
        ev.accept_evidence_tip(str(file))
    monkeypatch.setenv("CLAUDECODE", "1")
    with pytest.raises(PermissionError, match="not by an AI agent"):
        ev.accept_evidence_tip(str(file))
    assert tip_file.read_text() == before
    assert ev.verify_evidence_ledger(str(file))["truncated"] is True


def test_cli_accept_refuses_without_a_terminal(led, monkeypatch, capsys):
    file, tip_file = led
    monkeypatch.setattr(ev, "EVIDENCE_FILE", str(file))
    monkeypatch.setattr(cli, "EVIDENCE_FILE", str(file))
    append(file, 3)
    for var in ev._AGENT_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    before = tip_file.read_text()
    rc = cli.cmd_evidence(type("A", (), {"accept": True})())
    assert rc == 1
    assert "evidence --accept" in capsys.readouterr().err
    assert tip_file.read_text() == before


def test_accept_reanchors_and_keeps_previous(led):
    file, _ = led
    append(file, 5)
    old = ev.read_tip(str(file))
    cut_last(file, 2)
    done = ev.accept_evidence_tip(str(file), human=True)
    assert done["count"] == 3
    tip = ev.read_tip(str(file))
    assert tip["count"] == 3 and tip["previous"]["count"] == 5 and tip["previous"]["tip_hash"] == old["tip_hash"]
    v = ev.verify_evidence_ledger(str(file))
    assert v["valid"] and v["tip"]["previous"]["count"] == 5
    append(file, 1, "again")
    assert ev.read_tip(str(file))["previous"]["count"] == 5


def test_accept_on_an_archived_log_and_not_on_a_damaged_chain(led, tmp_path):
    file, _ = led
    append(file, 3)
    file.unlink()
    assert ev.accept_evidence_tip(str(file), human=True)["count"] == 0
    assert ev.verify_evidence_ledger(str(file))["valid"]
    append(file, 1, "fresh")
    assert ev.read_tip(str(file))["count"] == 1
    bad = tmp_path / "bad" / "evidence.jsonl"
    append(bad, 3)
    ls = lines(bad)
    ls[1] = ls[1].replace('"verdict":"allow"', '"verdict":"block"')
    bad.write_text("\n".join(ls) + "\n")
    with pytest.raises(ev.EvidenceLedgerError, match="cannot be accepted"):
        ev.accept_evidence_tip(str(bad), human=True)


def test_cli_verify_messages(led, monkeypatch, capsys):
    file, tip_file = led
    monkeypatch.setattr(cli, "verify_evidence_ledger", lambda: ev.verify_evidence_ledger(str(file)))
    args = type("A", (), {"verify": True})()
    append(file, 5)
    assert cli.cmd_evidence(args) == 0
    out = capsys.readouterr().out
    assert "HASH CHAIN VERIFIED, 5 records, no truncation found against the last tip" in out
    assert "IMMUTABLE" not in out
    tip = tip_file.read_text()
    tip_file.unlink()
    assert cli.cmd_evidence(args) == 0
    assert "Not anchored yet: removal of the last records cannot be detected until the next event." in capsys.readouterr().out
    tip_file.write_text(tip)
    cut_last(file, 1)
    assert cli.cmd_evidence(args) == 1
    err = capsys.readouterr().err
    assert "LOG TRUNCATED: 4 records found, the last tip expects at least 5" in err
    assert "run `zn-gate evidence --accept` in your own terminal." in err
    tip_file.write_text(json.dumps({**json.loads(tip), "count": 2, "tip_hash": "b" * 64}))
    assert cli.cmd_evidence(args) == 1
    assert "LOG REWRITTEN: record 2 differs from the tip" in capsys.readouterr().err


@pytest.mark.skipif(NODE is None or not EVIDENCE_JS.exists(), reason="node and the npm package sources are needed")
def test_interop_node_and_python_on_one_log(led, tmp_path):
    file, _ = led
    script = ("const { logEvidence, verifyEvidenceLedger } = require(process.argv[1]);"
              "const f = process.argv[2]; const n = Number(process.argv[3]);"
              "for (let i = 0; i < n; i++) { if (!logEvidence({ agent: 'n', tool_name: 'bash', payload: 'p' + i }, f)) process.exit(3); }"
              "console.log(JSON.stringify(verifyEvidenceLedger(f)));")
    env = {**os.environ, "ZN_STATS": "off"}

    def node(n):
        r = subprocess.run([NODE, "-e", script, str(EVIDENCE_JS), str(file), str(n)], capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout)

    node(2)
    assert ev.verify_evidence_ledger(str(file))["tip"]["count"] == 2
    append(file, 2, "py")
    assert ev.read_tip(str(file))["count"] == 4
    res = node(1)
    assert res["valid"] and res["anchored"] and res["tip"]["count"] == 5
    assert ev.verify_evidence_ledger(str(file))["tip"]["count"] == 5
    cut_last(file, 1)
    after = node(0)
    assert after["truncated"] is True
    assert after["error"] == ev.verify_evidence_ledger(str(file))["error"]
