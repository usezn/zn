"""
evidence --export --manifest and --include-preview: the manifest next to an export, the opt-in
payload preview for the Timesketch formats, and the refusals. Only temporary folders and invented
values. The CLI runs in a subprocess with ZN_HOME pointing at a temporary folder.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from types import SimpleNamespace

from zn_gate import evidence as ev
from zn_gate import evidence_timesketch as ts

SRC = str(Path(__file__).resolve().parents[1] / "src")
MANIFEST_KEYS = [
    "format", "source", "records", "first_timestamp", "last_timestamp", "chain_verified",
    "chain_break_index", "tip_record_hash", "export_sha256", "generator",
]


def _home(tmp_path, records):
    home = tmp_path / "home"
    home.mkdir()
    log = home / "evidence.jsonl"
    for r in records:
        ev.log_evidence(r, str(log))
    return home, log


def _run(home, *args):
    env = {**os.environ, "ZN_HOME": str(home), "PYTHONPATH": SRC, "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run([sys.executable, "-m", "zn_gate", "evidence", "--export", *args],
                          capture_output=True, text=True, env=env, timeout=120)


RECORDS = [
    {"verdict": "allow", "tool_name": "shell", "agent_environment": "agent-a", "payload": "first preview text"},
    {"verdict": "block", "tool_name": "shell", "agent_environment": "agent-a", "rule": "zn_state"},
]


# ------------------------------------------------------------------ manifest bytes

def test_manifest_keys_order_and_values(tmp_path):
    home, log = _home(tmp_path, RECORDS)
    out = tmp_path / "out.jsonl"
    proc = _run(home, "--format", "timesketch", "--output", str(out), "--manifest")
    assert proc.returncode == 0, proc.stderr
    raw = (tmp_path / "out.jsonl.manifest.json").read_bytes()
    assert raw.endswith(b"\n") and not raw.endswith(b"\n\n")
    manifest = json.loads(raw)
    assert list(manifest) == MANIFEST_KEYS
    assert manifest["format"] == "timesketch"
    assert manifest["source"] == "evidence.jsonl"
    assert manifest["records"] == 2
    assert manifest["chain_verified"] is True
    assert manifest["chain_break_index"] is None
    assert manifest["tip_record_hash"] == json.loads(log.read_text().splitlines()[-1])["record_hash"]
    assert manifest["export_sha256"] == hashlib.sha256(out.read_bytes()).hexdigest()
    assert manifest["generator"].startswith("zn-gate ")
    assert str(home) not in raw.decode("utf-8")


def test_manifest_on_tampered_log_names_the_break(tmp_path):
    home, log = _home(tmp_path, RECORDS + [{"verdict": "allow", "tool_name": "third"}])
    lines = log.read_text(encoding="utf-8").split("\n")
    lines[1] = lines[1].replace('"verdict":"block"', '"verdict":"allow"', 1)
    log.write_text("\n".join(lines), encoding="utf-8")
    out = tmp_path / "out.csv"
    _run(home, "--format", "csv", "--output", str(out), "--manifest")
    manifest = json.loads((tmp_path / "out.csv.manifest.json").read_text(encoding="utf-8"))
    assert manifest["chain_verified"] is False
    assert manifest["chain_break_index"] == 1
    assert manifest["tip_record_hash"] == json.loads(lines[0])["record_hash"]


@pytest.mark.parametrize("fmt", ["jsonl", "csv", "timesketch", "timesketch-csv"])
def test_export_exits_1_when_chain_fails_in_every_format(tmp_path, fmt):
    """Same as the npm package: a log whose chain does not verify exports, says so and exits 1."""
    home, log = _home(tmp_path, RECORDS)
    lines = log.read_text(encoding="utf-8").split("\n")
    lines[1] = lines[1].replace('"verdict":"block"', '"verdict":"allow"', 1)
    log.write_text("\n".join(lines), encoding="utf-8")
    proc = _run(home, "--format", fmt)
    assert proc.returncode == 1
    assert proc.stderr.splitlines()[0].startswith("Tamper detected: Tamper detected at line 2 (record ")
    assert proc.stdout  # the export is still written


def test_manifest_for_empty_missing_log(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    out = tmp_path / "out.jsonl"
    _run(home, "--output", str(out), "--manifest")
    manifest = json.loads((tmp_path / "out.jsonl.manifest.json").read_text(encoding="utf-8"))
    assert manifest["records"] == 0
    assert manifest["first_timestamp"] is None and manifest["tip_record_hash"] is None
    assert manifest["chain_verified"] is True


def test_manifest_text_renders_numbers_as_javascript(tmp_path):
    check = {"total": 3, "valid": False, "broken_index": 2, "first_timestamp": "a", "last_timestamp": None,
             "tip_record_hash": "f" * 64}
    text = ts.manifest_text(fmt="timesketch", source="evidence.jsonl", check=check,
                            export_sha256="0" * 64, generator="zn-gate 9.9.9")
    assert text == (
        '{"format":"timesketch","source":"evidence.jsonl","records":3,"first_timestamp":"a",'
        '"last_timestamp":null,"chain_verified":false,"chain_break_index":2,'
        '"tip_record_hash":"' + "f" * 64 + '","export_sha256":"' + "0" * 64 + '",'
        '"generator":"zn-gate 9.9.9"}\n'
    )


# ------------------------------------------------------------------ refusals

def test_manifest_without_output_is_refused(tmp_path):
    home, _ = _home(tmp_path, RECORDS)
    proc = _run(home, "--format", "timesketch", "--manifest")
    assert proc.returncode == 2
    assert proc.stderr.strip() == "zn-gate: --manifest needs --output FILE."


@pytest.mark.parametrize("fmt", ["jsonl", "csv"])
def test_include_preview_refused_for_other_formats(tmp_path, fmt):
    home, _ = _home(tmp_path, RECORDS)
    proc = _run(home, "--format", fmt, "--include-preview")
    assert proc.returncode == 2
    assert proc.stderr.strip() == "zn-gate: --include-preview works only with --format timesketch, timesketch-csv or ocsf."
    assert proc.stdout == ""


# ------------------------------------------------------------------ include-preview

def test_preview_is_opt_in_and_sits_before_chain_index(tmp_path):
    home, _ = _home(tmp_path, RECORDS)
    default = _run(home, "--format", "timesketch").stdout
    assert "zn_payload_preview" not in default
    with_preview = _run(home, "--format", "timesketch", "--include-preview").stdout.splitlines()
    first = json.loads(with_preview[0])
    assert "zn_payload_preview" not in json.loads(with_preview[1])  # second record has no payload
    keys = list(first)
    assert keys.index("zn_payload_preview") == keys.index("zn_chain_index") - 1
    assert first["zn_payload_preview"] == "first preview text"


def test_preview_csv_header_column_before_chain_index(tmp_path):
    home, _ = _home(tmp_path, RECORDS)
    header = _run(home, "--format", "timesketch-csv", "--include-preview").stdout.split("\n")[0].split(",")
    assert header[-3:] == ["zn_payload_preview", "zn_chain_index", "zn_chain_verified"]
    default_header = _run(home, "--format", "timesketch-csv").stdout.split("\n")[0]
    assert "zn_payload_preview" not in default_header
    assert default_header == ts.TIMESKETCH_CSV_HEADER_LINE


def test_preview_never_present_without_flag_even_for_timesketch_library(tmp_path):
    log = tmp_path / "evidence.jsonl"
    ev.log_evidence(RECORDS[0], str(log))
    assert "zn_payload_preview" not in ts.export_timesketch(str(log), "timesketch")["content"]
    assert "zn_payload_preview" in ts.export_timesketch(str(log), "timesketch", include_preview=True)["content"]


FORMULA_RECORDS = [
    {"verdict": "allow", "tool_name": '=HYPERLINK("http://example.invalid")', "agent_environment": "agent-a"},
    {"verdict": "block", "tool_name": "-2+3", "agent_environment": "@agent", "rule": "+rule"},
    {"verdict": "allow", "tool_name": "plain", "agent_environment": "agent-a"},
]


def test_csv_formula_cells_get_a_single_quote(tmp_path):
    home, _ = _home(tmp_path, FORMULA_RECORDS + [{"verdict": "allow", "tool_name": "\tcmd"}])
    lines = _run(home, "--format", "csv").stdout.split("\n")
    assert '"\'=HYPERLINK(""http://example.invalid"")"' in lines[1]
    assert '"\'-2+3"' in lines[2] and '"\'+rule"' in lines[2]
    assert '"plain"' in lines[3] and '"\'' not in lines[3]
    assert '"\'\tcmd"' in lines[4]
    ts_out = _run(home, "--format", "timesketch-csv").stdout
    assert '"\'=HYPERLINK(""http://example.invalid"")' in ts_out
    for line in ts_out.split("\n")[1:]:
        for cell in re.findall(r'"(?:[^"]|"")*"', line):
            assert not re.match(r'"[=+\-@\t\r]', cell), cell


def test_manifest_refuses_an_existing_path(tmp_path):
    home, _ = _home(tmp_path, RECORDS)
    out = tmp_path / "out.jsonl"
    Path(str(out) + ".manifest.json").write_text("keep me")
    r = _run(home, "--output", str(out), "--manifest")
    assert r.returncode == 2
    assert "manifest.json already exists or is a link; --manifest does not overwrite it" in r.stderr
    assert Path(str(out) + ".manifest.json").read_text() == "keep me"
    assert not out.exists()


@pytest.mark.skipif(os.name == "nt", reason="symlinks need a privilege on Windows")
def test_manifest_refuses_a_symlink_and_does_not_write_through_it(tmp_path):
    home, _ = _home(tmp_path, RECORDS)
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    out = tmp_path / "out.jsonl"
    link = Path(str(out) + ".manifest.json")
    link.symlink_to(victim)
    assert _run(home, "--output", str(out), "--manifest").returncode == 2
    assert victim.read_text() == "keep me"
    link.unlink()
    link.symlink_to(tmp_path / "not-there.txt")
    assert _run(home, "--output", str(out), "--manifest").returncode == 2
    assert not (tmp_path / "not-there.txt").exists()


def test_manifest_describes_the_log_as_the_export_saw_it(tmp_path, monkeypatch, capsys):
    """A record appended between the export and the manifest does not change the manifest's counts or tip."""
    from zn_gate import cli
    home, log = _home(tmp_path, RECORDS)
    before = log.read_text(encoding="utf-8").splitlines()
    out = tmp_path / "out.jsonl"
    real_export = cli.export_evidence_ledger

    def export_then_append(*a, **kw):
        res = real_export(*a, **kw)
        with open(log, "a", encoding="utf-8") as f:
            f.write('{"id":"late","timestamp":"2026-11-27T00:00:00.000Z"}' + chr(10))
        return res

    monkeypatch.setattr(cli, "EVIDENCE_FILE", str(log))
    monkeypatch.setattr(ev, "EVIDENCE_FILE", str(log))
    monkeypatch.setattr(cli, "export_evidence_ledger", export_then_append)
    args = SimpleNamespace(verify=False, export=True, pack_action=None, output=str(out), format="jsonl",
                           include_preview=False, manifest=True)
    assert cli.cmd_evidence(args) == 0
    capsys.readouterr()
    manifest = json.loads((tmp_path / "out.jsonl.manifest.json").read_text(encoding="utf-8"))
    assert manifest["records"] == 2
    assert manifest["chain_verified"] is True
    assert manifest["tip_record_hash"] == json.loads(before[-1])["record_hash"]


def test_jsonl_export_reads_only_what_the_chain_check_covered(tmp_path, monkeypatch):
    """A record appended between the chain check and the raw read is not in the export."""
    home, log = _home(tmp_path, RECORDS)
    original = log.read_text(encoding="utf-8")
    real = ts.inspect_ledger

    def check_then_append(path):
        result = real(path)
        with open(log, "a", encoding="utf-8") as f:
            f.write('{"id":"late","timestamp":"2026-11-27T00:00:00.000Z"}' + chr(10))
        return result

    monkeypatch.setattr(ts, "inspect_ledger", check_then_append)
    for fmt in ("jsonl", "csv", "timesketch"):
        res = ev.export_evidence_ledger(str(log), format=fmt)
        assert res["valid"] is True and res["total"] == 2
        if fmt == "jsonl":
            assert res["content"] == original
        log.write_text(original, encoding="utf-8")
