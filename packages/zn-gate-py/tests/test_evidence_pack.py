"""evidence pack (evidence pack --out DIR): date range edges, refusals, a tampered log, manifest hashes,
the payload preview, the control map wording, and byte parity with the Node package on the same ledger.
Only temporary folders and invented values."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from zn_gate import cli
from zn_gate import evidence as py_ev
from zn_gate.evidence_pack import PACK_FILES, write_evidence_pack

NODE = shutil.which("node")
ROOT = Path(__file__).resolve().parents[2]
NODE_EVIDENCE = ROOT / "zn-gate" / "lib" / "evidence.js"
GENESIS = "0" * 64
DISCLAIMER = "zn-gate does not make a system compliant, and this pack is not an attestation."
FIXED_NOW = datetime(2026, 11, 27, 10, 0, 0, tzinfo=timezone.utc)


def _build_ledger(path, specs):
    """A ledger with the given record fields and timestamps; the chain is built here."""
    prev = GENESIS
    lines = []
    for i, spec in enumerate(specs):
        base = {"id": f"ev_test_{i}", **spec, "prev_hash": prev}
        record_hash = hashlib.sha256((prev + ":" + py_ev._canonical(base)).encode("utf-8")).hexdigest()
        line = py_ev._canonical({**base, "record_hash": record_hash})
        lines.append(line)
        prev = record_hash
    Path(path).write_text("".join(line + "\n" for line in lines), encoding="utf-8")
    return lines


def _rec(timestamp, **extra):
    base = {
        "timestamp": timestamp,
        "agent_environment": "agent-a",
        "phase": "tool-call",
        "tool_name": "shell",
        "payload_sha256": "0" * 64,
        "payload_preview": "preview text for " + timestamp,
        "verdict": "allow",
        "rule": None,
        "reason": None,
        "confidence": 1,
        "latency_us": 3,
        "engine": "e",
    }
    base.update(extra)
    return base


SPECS = [
    _rec("2026-11-01T10:00:00.000Z"),
    _rec("2026-11-02T00:00:00.000Z", verdict="block", rule="R-SHELL-1", agent_environment="agent-b"),
    _rec("2026-11-03T23:59:59.999Z", verdict="allow", rule="R-NET-2"),
    _rec("2026-11-04T00:00:00.000Z"),
    _rec("not a time", verdict="block", rule="R-UNDATED"),
]


@pytest.fixture
def ledger(tmp_path):
    log = tmp_path / "evidence.jsonl"
    lines = _build_ledger(log, SPECS)
    return SimpleNamespace(log=str(log), lines=lines, dir=tmp_path, out=str(tmp_path / "pack"))


@pytest.fixture
def run(monkeypatch, ledger, capsys):
    monkeypatch.setattr(cli, "EVIDENCE_FILE", ledger.log)

    def _run(out, **kw):
        args = SimpleNamespace(verify=False, export=False, pack_action="pack", out=out, since=kw.get("since"),
                               until=kw.get("until"), format=kw.get("format", "jsonl"),
                               include_preview=kw.get("include_preview", False))
        code = cli.cmd_evidence(args)
        return code, capsys.readouterr()
    return _run


def _read_pack(out):
    return {f: Path(out, f).read_bytes() for f in PACK_FILES + ("manifest.json",)}


def test_range_is_inclusive_utc_days_and_undated_is_counted(ledger, run):
    code, _ = run(ledger.out, since="2026-11-02", until="2026-11-03")
    assert code == 0
    files = _read_pack(ledger.out)
    lines = files["records.jsonl"].decode("utf-8").splitlines()
    assert len(lines) == 2
    summary = json.loads(files["summary.json"])
    assert summary["period"] == {"since": "2026-11-02", "until": "2026-11-03"}
    assert summary["records"] == 2
    assert summary["undated"] == 1
    assert summary["undated_included"] is False
    assert summary["verdicts"] == {"allow": 1, "block": 1}
    assert summary["rules"] == {"R-NET-2": 1, "R-SHELL-1": 1}
    assert summary["agents"] == {"agent-a": 1, "agent-b": 1}
    assert summary["first_timestamp"] == "2026-11-02T00:00:00.000Z"
    assert summary["last_timestamp"] == "2026-11-03T23:59:59.999Z"
    chain = json.loads(files["chain.json"])
    assert chain["range_records"] == 2
    assert chain["range_first"] == {"chain_index": 1, "record_hash": json.loads(ledger.lines[1])["record_hash"]}
    assert chain["range_last"]["chain_index"] == 2


def test_single_day_and_no_range_keeps_undated(ledger, run):
    code, _ = run(ledger.out + "-day", since="2026-11-04", until="2026-11-04")
    assert code == 0
    assert json.loads(_read_pack(ledger.out + "-day")["summary.json"])["records"] == 1
    code, _ = run(ledger.out)
    assert code == 0
    summary = json.loads(_read_pack(ledger.out)["summary.json"])
    assert summary["records"] == 5
    assert summary["undated"] == 1
    assert summary["undated_included"] is True
    assert summary["period"] == {"since": None, "until": None}


def test_refused_folder_is_not_empty_and_is_left_alone(ledger, run, capsys):
    Path(ledger.out).mkdir()
    Path(ledger.out, "keep.txt").write_text("mine", encoding="utf-8")
    code, cap = run(ledger.out)
    assert code == 2
    assert len(cap.err.strip().splitlines()) == 1
    assert sorted(os.listdir(ledger.out)) == ["keep.txt"]
    assert Path(ledger.out, "keep.txt").read_text(encoding="utf-8") == "mine"


def test_refused_bad_dates_and_inverted_range_and_csv(ledger, run):
    assert run(ledger.dir / "b1", since="2026-02-30")[0] == 2
    assert run(ledger.dir / "b2", until="2026-1-1")[0] == 2
    assert run(ledger.dir / "b3", since="2026-11-05", until="2026-11-01")[0] == 2
    assert not (ledger.dir / "b3").exists()
    assert run(ledger.dir / "b4", format="csv")[0] == 2


def test_tampered_log_exit_1_and_chain_says_so(ledger, run):
    lines = Path(ledger.log).read_text(encoding="utf-8").split("\n")
    lines[1] = lines[1].replace("R-SHELL-1", "R-EDITED")
    Path(ledger.log).write_text("\n".join(lines), encoding="utf-8")
    code, _ = run(ledger.out)
    assert code == 1
    chain = json.loads(_read_pack(ledger.out)["chain.json"])
    assert chain["verified"] is False
    assert chain["break_index"] == 1
    assert "hash mismatch" in chain["error"]
    assert Path(ledger.out, "manifest.json").exists()


def test_manifest_hashes_match_the_files(ledger, run):
    assert run(ledger.out)[0] == 0
    manifest = json.loads(_read_pack(ledger.out)["manifest.json"])
    assert list(manifest["files"]) == list(PACK_FILES)
    for name in PACK_FILES:
        data = Path(ledger.out, name).read_bytes()
        assert manifest["files"][name]["sha256"] == hashlib.sha256(data).hexdigest(), name
        assert manifest["files"][name]["bytes"] == len(data), name
    assert manifest["generator"].startswith("zn-gate ")


def test_payload_preview_left_out_by_default_and_kept_with_flag(ledger, run):
    assert run(ledger.out)[0] == 0
    plain = _read_pack(ledger.out)["records.jsonl"].decode("utf-8")
    assert "payload_preview" not in plain
    assert len(plain.splitlines()) == 5
    kept_dir = ledger.out + "-preview"
    assert run(kept_dir, include_preview=True)[0] == 0
    assert Path(kept_dir, "records.jsonl").read_bytes() == ("\n".join(ledger.lines) + "\n").encode("utf-8")


def test_controls_have_the_disclaimer_and_no_other_compliance_wording(ledger, run):
    assert run(ledger.out)[0] == 0
    text = _read_pack(ledger.out)["controls.md"].decode("utf-8")
    assert DISCLAIMER in text
    rest = text.replace(DISCLAIMER, "").replace("this pack is not an attestation", "")
    for word in ("compliant", "compliance", "certif", "attest", "SOC 2 ready"):
        assert word.lower() not in rest.lower(), word
    for criterion in ("CC6.1", "CC6.6", "CC7.2", "CC8.1"):
        assert criterion in text


def test_empty_log_gives_an_empty_pack_that_verifies(tmp_path, monkeypatch, capsys):
    log = tmp_path / "evidence.jsonl"
    log.write_text("", encoding="utf-8")
    out = tmp_path / "pack"
    chain = json.loads(_build_and_read(log, out, monkeypatch, capsys, "chain.json"))
    assert chain["records"] == 0 and chain["verified"] is True
    assert Path(out, "records.jsonl").read_bytes() == b""


def _build_and_read(log, out, monkeypatch, capsys, name):
    monkeypatch.setattr(cli, "EVIDENCE_FILE", str(log))
    args = SimpleNamespace(verify=False, export=False, pack_action="pack", out=str(out), since=None,
                           until=None, format="jsonl", include_preview=False)
    assert cli.cmd_evidence(args) == 0
    capsys.readouterr()
    return Path(out, name).read_bytes()


def test_module_writes_a_range_without_the_cli(ledger):
    res = write_evidence_pack(ledger.log, ledger.out + "-direct", since="2026-11-02", until="2026-11-03",
                              generator="zn-gate test", now=FIXED_NOW)
    assert res["valid"] is True
    assert res["records"] == 2


# ------------------------------------------------------------------- parity with the Node package

_NODE_DRIVER = """
const ev = require(process.argv[1]);
const [file, out, optsJson] = process.argv.slice(2);
const o = JSON.parse(optsJson);
ev.writeEvidencePack(out, {
  since: o.since, until: o.until, format: o.format || 'jsonl', includePreview: !!o.includePreview,
  generator: 'zn-gate test', now: new Date('2026-11-27T10:00:00Z'),
}, file);
"""

PARITY_SPECS = SPECS + [
    _rec("2026-11-02T12:00:00.500Z", confidence=0.00001, latency_us=12.7, rule=None, reason="café €"),
    _rec("2026-11-02T13:00:00Z", confidence=1e-7, payload_preview="\"quoted\" and \\ backslash"),
    _rec("2026-11-03T08:00:00.000Z", verdict="block", rule="R-ü-3", payload_preview="plain"),
    _rec("2026-02-29T08:00:00.000Z"),
    _rec("2026-11-03T09:00:00.000Z", tool_name="“quoted tool”"),
]

PARITY_CASES = [
    {},
    {"since": "2026-11-02", "until": "2026-11-03"},
    {"includePreview": True},
    {"since": "2026-11-02", "until": "2026-11-03", "includePreview": True},
    {"format": "ocsf"},
    {"format": "ocsf", "since": "2026-11-02", "until": "2026-11-03"},
    {"format": "ocsf", "includePreview": True},
]


@pytest.mark.skipif(NODE is None or not NODE_EVIDENCE.is_file(), reason="Node package not available")
@pytest.mark.parametrize("case", PARITY_CASES,
                         ids=["all", "range", "preview", "range-preview", "ocsf", "ocsf-range", "ocsf-preview"])
def test_node_and_python_write_the_same_pack(tmp_path, case):
    log = tmp_path / "evidence.jsonl"
    _build_ledger(log, PARITY_SPECS)
    node_out = tmp_path / "node"
    subprocess.run([NODE, "-e", _NODE_DRIVER, str(NODE_EVIDENCE), str(log), str(node_out), json.dumps(case)],
                   check=True, timeout=120)
    py_out = tmp_path / "py"
    write_evidence_pack(
        str(log), str(py_out), since=case.get("since"), until=case.get("until"), fmt=case.get("format", "jsonl"),
        include_preview=bool(case.get("includePreview")), generator="zn-gate test", now=FIXED_NOW,
    )
    names = sorted(os.listdir(node_out))
    assert names == sorted(os.listdir(py_out))
    assert "manifest.json" in names
    for name in names:
        assert (node_out / name).read_bytes() == (py_out / name).read_bytes(), name


def test_ocsf_pack_has_events_for_records_only_and_verified_flags(ledger, run):
    assert run(ledger.out, format="ocsf")[0] == 0
    lines = Path(ledger.out, "records.ocsf.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 5
    first = json.loads(lines[0])
    assert first["class_uid"] == 2004
    assert first["unmapped"]["zn_chain_verified"] is True
    assert "payload_preview" not in "".join(lines)
    manifest = json.loads(Path(ledger.out, "manifest.json").read_text(encoding="utf-8"))
    assert "records.ocsf.jsonl" in manifest["files"]
    assert "records.jsonl" not in manifest["files"]


def test_timesketch_is_refused_and_ocsf_is_accepted(ledger, run):
    assert run(ledger.dir / "t1", format="timesketch")[0] == 2
    assert run(ledger.dir / "t2", format="ocsf")[0] == 0


def test_controls_name_the_verdicts_the_log_holds(ledger, run):
    assert run(ledger.out)[0] == 0
    text = _read_pack(ledger.out)["controls.md"].decode("utf-8")
    assert 'The verdict is "allow" or "block".' in text


def test_snapshot_a_log_changed_after_the_chain_check_does_not_change_the_pack(ledger, monkeypatch, tmp_path):
    """The chain check and the record selection read the same bytes, even if the log changes between them."""
    from zn_gate import evidence_pack as mod
    original = Path(ledger.log).read_bytes()
    real = mod.inspect_ledger
    calls = []

    def mutate_after(path):
        result = real(path)
        calls.append(path)
        forged = list(ledger.lines)
        forged[1] = forged[1].replace('"verdict":"block"', '"verdict":"allow"')
        Path(ledger.log).write_text("\n".join(forged) + "\n" + json.dumps({"id": "late", "timestamp": "2026-11-02T01:00:00.000Z"}) + "\n",
                                    encoding="utf-8")
        return result

    monkeypatch.setattr(mod, "inspect_ledger", mutate_after)
    res = write_evidence_pack(ledger.log, str(tmp_path / "snap"), generator="test", include_preview=True, now=FIXED_NOW)
    assert len(calls) == 1 and calls[0] != ledger.log  # read from the private copy
    assert Path(tmp_path / "snap", "records.jsonl").read_bytes() == original
    chain = json.loads(Path(tmp_path / "snap", "chain.json").read_text(encoding="utf-8"))
    assert chain["verified"] is True and chain["records"] == 5 and chain["range_records"] == 5
    assert res["valid"] is True
    assert not os.path.exists(os.path.dirname(calls[0]))  # the copy is removed


def test_snapshot_missing_log_gives_an_empty_pack(tmp_path):
    res = write_evidence_pack(str(tmp_path / "nope.jsonl"), str(tmp_path / "p"), generator="test", now=FIXED_NOW)
    assert res["total"] == 0 and res["records"] == 0


def test_readme_names_the_records_file_the_pack_writes(ledger, run):
    code, _ = run(ledger.out)
    assert code == 0
    code, _ = run(ledger.out + "-ocsf", format="ocsf")
    assert code == 0
    jsonl_readme = Path(ledger.out, "README.txt").read_text(encoding="utf-8")
    ocsf_readme = Path(ledger.out + "-ocsf", "README.txt").read_text(encoding="utf-8")
    assert "sha256sum records.jsonl chain.json" in jsonl_readme
    assert "Get-FileHash -Algorithm SHA256 records.jsonl\n" in jsonl_readme
    assert "records.ocsf.jsonl" not in jsonl_readme
    assert "sha256sum records.ocsf.jsonl chain.json" in ocsf_readme
    assert "Get-FileHash -Algorithm SHA256 records.ocsf.jsonl\n" in ocsf_readme
    assert "records.jsonl" not in ocsf_readme


def test_read_error_says_the_pack_was_not_written_and_writes_nothing(ledger, run, monkeypatch):
    from zn_gate import evidence_pack as ep

    def boom(file_path, tmp_dir):
        raise ep.PackReadError("Cannot read the evidence log: EIO")

    monkeypatch.setattr(ep, "_snapshot_log", boom)
    code, cap = run(ledger.out)
    assert code == 1
    assert f"zn-gate: the pack stopped. Cannot read the evidence log: EIO. {ledger.out} was not written." in cap.err
    assert "incomplete" not in cap.err
    assert not os.path.exists(ledger.out)
