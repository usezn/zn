"""The Node and Python packages write the same evidence record for the same event, and a ledger
written by one verifies with the other."""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

NODE = shutil.which("node")
ROOT = Path(__file__).resolve().parents[2]
NODE_EVIDENCE = ROOT / "zn-gate" / "lib" / "evidence.js"
SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from zn_gate import evidence as py_ev  # noqa: E402

pytestmark = pytest.mark.skipif(
    NODE is None or not NODE_EVIDENCE.is_file(), reason="Node package not available"
)

_DRIVER = """
const ev = require(process.argv[2]);
const [mode, file, eventsFile] = process.argv.slice(3);
if (mode === 'write') {
  const events = JSON.parse(require('fs').readFileSync(eventsFile, 'utf8'));
  for (const e of events) ev.logEvidence(e, file, { noStats: true });
} else {
  process.stdout.write(JSON.stringify(ev.verifyEvidenceLedger(file)));
}
"""

BASE = {"agent": "a", "engine": "e", "tool_name": "t", "phase": "p", "verdict": "allow"}

EVENTS = [
    {"confidence": 0},
    {"confidence": 0.5},
    {"confidence": 0.00001},
    {"confidence": 1e-7},
    {"confidence": 0.000123},
    {"confidence": 1},
    {"confidence": None},
    {},
    {"rule": "", "reason": ""},
    {"rule": "R1", "reason": "why"},
    {"phase": "", "tool_name": "", "verdict": ""},
    {"payload": {"k": "caf\u00e9 \u20ac"}},
    {"payload": 0},
    {"payload": False},
    {"payload": None},
    {"payload": []},
    {"payload": "plain text \u00e9"},
    {"latency_us": 12.7},
    {"latency_us": 5},
    {"payload": "@@zn-confidence@@", "confidence": 0.5},
    {"payload": "\"confidence\":\"x\"", "confidence": 0.25},
]


def _event(extra):
    return {**BASE, **extra}


def _node_write(tmp_path, events, name="node.jsonl"):
    driver = tmp_path / "driver.js"
    driver.write_text(_DRIVER, encoding="utf-8")
    ev_file = tmp_path / (name + ".events.json")
    ev_file.write_text(json.dumps(events), encoding="utf-8")
    ledger = tmp_path / name
    subprocess.run(
        [NODE, str(driver), str(NODE_EVIDENCE), "write", str(ledger), str(ev_file)],
        check=True, timeout=60,
    )
    return ledger


def _node_verify(tmp_path, ledger):
    driver = tmp_path / "driver.js"
    driver.write_text(_DRIVER, encoding="utf-8")
    out = subprocess.run(
        [NODE, str(driver), str(NODE_EVIDENCE), "verify", str(ledger), ""],
        check=True, capture_output=True, text=True, timeout=60,
    )
    return json.loads(out.stdout)


def _py_write(tmp_path, events, name="py.jsonl"):
    ledger = tmp_path / name
    for e in events:
        py_ev.log_evidence(e, str(ledger))
    return ledger


def _records(ledger):
    return [json.loads(x) for x in ledger.read_text(encoding="utf-8").splitlines()]


VOLATILE = {"id", "timestamp", "record_hash", "prev_hash"}


@pytest.mark.parametrize("extra", EVENTS, ids=[json.dumps(e) for e in EVENTS])
def test_same_event_gives_same_fields(tmp_path, extra):
    event = _event(extra)
    node = _records(_node_write(tmp_path, [event]))[0]
    py = _records(_py_write(tmp_path, [event]))[0]
    strip = lambda r: {k: v for k, v in r.items() if k not in VOLATILE}  # noqa: E731
    assert strip(node) == strip(py)


def test_ledger_written_by_node_verifies_in_python(tmp_path):
    ledger = _node_write(tmp_path, [_event(e) for e in EVENTS])
    result = py_ev.verify_evidence_ledger(str(ledger))
    assert result["valid"], result
    assert result["total"] == len(EVENTS)


def test_ledger_written_by_python_verifies_in_node(tmp_path):
    ledger = _py_write(tmp_path, [_event(e) for e in EVENTS])
    result = _node_verify(tmp_path, ledger)
    assert result["valid"], result
    assert result["total"] == len(EVENTS)


@pytest.mark.parametrize("conf", [0.00001, 1e-7, 0.000123, 1.5e-9, 0.1, 0.30000000000000004])
def test_small_confidence_verifies_both_ways(tmp_path, conf):
    event = _event({"confidence": conf})
    n = _node_write(tmp_path, [event])
    p = _py_write(tmp_path, [event])
    assert py_ev.verify_evidence_ledger(str(n))["valid"]
    assert _node_verify(tmp_path, p)["valid"]


def test_old_python_number_form_still_verifies_in_node(tmp_path):
    """A record written by an older Python (confidence as repr, 1e-05) keeps verifying in both."""
    import hashlib

    base = {
        "id": "ev_old", "timestamp": "2026-01-01T00:00:00+00:00", "agent_environment": "a",
        "phase": "p", "tool_name": "t", "payload_sha256": "0" * 64, "payload_preview": "",
        "verdict": "allow", "rule": None, "reason": None, "confidence": 1e-05, "latency_us": 0,
        "engine": "e", "prev_hash": "0" * 64,
    }
    text = json.dumps(base, separators=(",", ":"), ensure_ascii=False)
    assert '"confidence":1e-05' in text
    h = hashlib.sha256(("0" * 64 + ":" + text).encode()).hexdigest()
    ledger = tmp_path / "old.jsonl"
    ledger.write_text(json.dumps({**base, "record_hash": h}, ensure_ascii=False) + "\n", encoding="utf-8")
    assert py_ev.verify_evidence_ledger(str(ledger))["valid"]
    assert _node_verify(tmp_path, ledger)["valid"]


def test_many_confidences_verify_both_ways(tmp_path):
    import random

    rng = random.Random(2917)
    values = [10 ** rng.uniform(-12, 0) * rng.choice([1, 1, 0.5]) for _ in range(300)]
    values += [round(rng.random(), rng.randint(1, 8)) for _ in range(100)]
    events = [_event({"confidence": v}) for v in values]
    n = _node_write(tmp_path, events)
    p = _py_write(tmp_path, events)
    assert py_ev.verify_evidence_ledger(str(n))["valid"]
    assert _node_verify(tmp_path, p)["valid"]
    for rec_n, rec_p, v in zip(_records(n), _records(p), values, strict=True):
        assert rec_n["confidence"] == rec_p["confidence"] == v


def test_many_old_python_form_ledger_verifies_in_both(tmp_path):
    """A ledger hashed the way earlier Python versions did (native json.dumps numbers)."""
    import hashlib
    import random

    rng = random.Random(7)
    prev = "0" * 64
    lines = []
    for i in range(300):
        base = {
            "id": "ev_%d" % i, "timestamp": "2026-01-01T00:00:00+00:00", "agent_environment": "a",
            "phase": "p", "tool_name": "t", "payload_sha256": "0" * 64, "payload_preview": "café",
            "verdict": "allow", "rule": None, "reason": None,
            "confidence": 10 ** rng.uniform(-12, 0), "latency_us": 0, "engine": "e", "prev_hash": prev,
        }
        text = json.dumps(base, separators=(",", ":"), ensure_ascii=False)
        prev = hashlib.sha256((base["prev_hash"] + ":" + text).encode()).hexdigest()
        lines.append(json.dumps({**base, "record_hash": prev}, ensure_ascii=False))
    ledger = tmp_path / "old_many.jsonl"
    ledger.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert py_ev.verify_evidence_ledger(str(ledger))["valid"]
    assert _node_verify(tmp_path, ledger)["valid"]


_EXPORT_DRIVER = """
const ev = require(process.argv[2]);
const { Writable } = require('stream');
const [file, format] = process.argv.slice(3);
const chunks = [];
const out = new Writable({ write(c, _enc, cb) { chunks.push(Buffer.from(c)); cb(); } });
ev.writeEvidenceExport(file, format, out).then(() => {
  process.stdout.write(Buffer.concat(chunks));
});
"""

# Floats (whole and fractional), booleans, nested objects, a missing field, a non-ASCII tool name
# and a payload that becomes payload_preview.
TS_EVENTS = [
    _event({"tool_name": "herramienta-ñ 工具 \U0001f527", "verdict": "deny", "rule": "R1",
            "reason": "why", "latency_us": 12.7, "confidence": 0.5}),
    _event({"latency_us": 12.0, "confidence": 1, "rule": None}),
    _event({"reason": {"a": 1, "b": [True, None, 2.5]}, "confidence": 1e-7}),
    _event({"payload": {"k": "secret text the agent wrote"}, "rule": "", "reason": 'x"y\\z'}),
    _event({"confidence": 0.000123, "latency_us": 5, "reason": False}),
    dict(BASE),  # no reason, rule or confidence
]


def _node_export(tmp_path, ledger, fmt):
    driver = tmp_path / "export_driver.js"
    driver.write_text(_EXPORT_DRIVER, encoding="utf-8")
    out = subprocess.run(
        [NODE, str(driver), str(NODE_EVIDENCE), str(ledger), fmt],
        check=True, capture_output=True, timeout=60,
    )
    return out.stdout


def _py_export(ledger, fmt):
    return py_ev.export_evidence_ledger(str(ledger), fmt)["content"].encode("utf-8")


@pytest.mark.parametrize("fmt", ["timesketch", "timesketch-csv"])
def test_timesketch_export_bytes_match_node_on_node_ledger(tmp_path, fmt):
    ledger = _node_write(tmp_path, TS_EVENTS)
    assert _node_export(tmp_path, ledger, fmt) == _py_export(ledger, fmt)


@pytest.mark.parametrize("fmt", ["timesketch", "timesketch-csv"])
def test_timesketch_export_bytes_match_node_on_python_ledger(tmp_path, fmt):
    ledger = _py_write(tmp_path, TS_EVENTS)
    assert _node_export(tmp_path, ledger, fmt) == _py_export(ledger, fmt)


@pytest.mark.parametrize("fmt", ["timesketch", "timesketch-csv"])
def test_timesketch_export_bytes_match_node_after_tamper(tmp_path, fmt):
    ledger = _node_write(tmp_path, TS_EVENTS)
    lines = ledger.read_text(encoding="utf-8").split("\n")
    lines[2] = lines[2].replace('"verdict":"allow"', '"verdict":"deny"', 1)
    ledger.write_text("\n".join(lines), encoding="utf-8")
    node = _node_export(tmp_path, ledger, fmt)
    assert node == _py_export(ledger, fmt)
    assert b"false" in node


NODE_CLI = ROOT / "zn-gate" / "bin" / "cli.js"
_GENERATOR = re.compile(rb'"generator":"zn-gate [^"]*"')


def _cli_pair(tmp_path, ledger, fmt, extra):
    """Runs the export through both command lines on the same log (ZN_HOME holds it) and returns
    (node_result, python_result, node_output, python_output)."""
    home = tmp_path / "home"
    home.mkdir()
    shutil.copy(ledger, home / "evidence.jsonl")
    node_dir, py_dir = tmp_path / "node", tmp_path / "py"
    node_dir.mkdir()
    py_dir.mkdir()
    node_out, py_out = node_dir / "out.txt", py_dir / "out.txt"
    env = {**os.environ, "ZN_HOME": str(home)}
    node = subprocess.run(
        [NODE, str(NODE_CLI), "evidence", "--export", "--format", fmt, "--output", str(node_out), *extra],
        capture_output=True, env=env, timeout=120,
    )
    py_env = {**env, "PYTHONPATH": str(SRC), "PYTHONDONTWRITEBYTECODE": "1"}
    python = subprocess.run(
        [sys.executable, "-m", "zn_gate", "evidence", "--export", "--format", fmt, "--output", str(py_out), *extra],
        capture_output=True, env=py_env, timeout=120,
    )
    return node, python, node_out, py_out


def _same_export_and_manifest(tmp_path, ledger, fmt, extra, expect_code=0):
    node, python, node_out, py_out = _cli_pair(tmp_path, ledger, fmt, extra)
    assert node.returncode == python.returncode == expect_code, (node.stderr, python.stderr)
    assert node_out.read_bytes() == py_out.read_bytes()
    if "--manifest" in extra:
        n_man = (node_out.parent / "out.txt.manifest.json").read_bytes()
        p_man = (py_out.parent / "out.txt.manifest.json").read_bytes()
        assert _GENERATOR.search(n_man) and _GENERATOR.search(p_man)
        # generator is the only field allowed to differ, when the two versions differ
        assert _GENERATOR.sub(b'"generator":"G"', n_man) == _GENERATOR.sub(b'"generator":"G"', p_man)
    return node, python


@pytest.mark.parametrize("fmt, extra", [
    ("timesketch", ["--include-preview"]),
    ("timesketch-csv", ["--include-preview"]),
    ("timesketch", ["--manifest"]),
    ("timesketch-csv", ["--manifest", "--include-preview"]),
    ("jsonl", []),
    ("jsonl", ["--manifest"]),
    ("csv", []),
    ("csv", ["--manifest"]),
    ("ocsf", []),
    ("ocsf", ["--include-preview"]),
    ("ocsf", ["--manifest"]),
    ("ocsf", ["--manifest", "--include-preview"]),
], ids=["ts-preview", "tscsv-preview", "ts-manifest", "tscsv-manifest-preview",
        "jsonl", "jsonl-manifest", "csv", "csv-manifest",
        "ocsf", "ocsf-preview", "ocsf-manifest", "ocsf-manifest-preview"])
def test_cli_export_and_manifest_match_node(tmp_path, fmt, extra):
    ledger = _node_write(tmp_path, TS_EVENTS)
    _same_export_and_manifest(tmp_path, ledger, fmt, extra)


@pytest.mark.parametrize("fmt", ["jsonl", "csv", "timesketch", "timesketch-csv", "ocsf"])
def test_stdout_bytes_match_node(tmp_path, fmt):
    """Without --output the export goes to stdout: same bytes, LF line endings, same exit code."""
    ledger = _node_write(tmp_path, TS_EVENTS)
    home = tmp_path / "home"
    home.mkdir()
    shutil.copy(ledger, home / "evidence.jsonl")
    env = {**os.environ, "ZN_HOME": str(home)}
    node = subprocess.run([NODE, str(NODE_CLI), "evidence", "--export", "--format", fmt],
                          capture_output=True, env=env, timeout=120)
    python = subprocess.run(
        [sys.executable, "-m", "zn_gate", "evidence", "--export", "--format", fmt],
        capture_output=True, env={**env, "PYTHONPATH": str(SRC), "PYTHONDONTWRITEBYTECODE": "1"}, timeout=120,
    )
    assert node.returncode == python.returncode == 0, python.stderr
    assert node.stdout == python.stdout
    assert b"\r\n" not in python.stdout


def test_cli_manifest_matches_node_after_tamper(tmp_path):
    ledger = _node_write(tmp_path, TS_EVENTS)
    lines = ledger.read_text(encoding="utf-8").split("\n")
    lines[2] = lines[2].replace('"verdict":"allow"', '"verdict":"deny"', 1)
    ledger.write_text("\n".join(lines), encoding="utf-8")
    node, python = _same_export_and_manifest(tmp_path, ledger, "timesketch-csv",
                                             ["--manifest", "--include-preview"], expect_code=1)
    # Both exit 1 and print the same first line (the tamper message).
    assert node.stderr.decode("utf-8").splitlines()[0] == python.stderr.decode("utf-8").splitlines()[0]
    man = (tmp_path / "py" / "out.txt.manifest.json").read_text(encoding="utf-8")
    assert '"chain_verified":false,"chain_break_index":2' in man


def test_ocsf_tampered_log_matches_node(tmp_path):
    ledger = _node_write(tmp_path, TS_EVENTS)
    lines = ledger.read_text(encoding="utf-8").split("\n")
    lines[2] = lines[2].replace('"verdict":"allow"', '"verdict":"block"', 1)
    ledger.write_text("\n".join(lines), encoding="utf-8")
    node, python = _same_export_and_manifest(tmp_path, ledger, "ocsf", ["--include-preview", "--manifest"],
                                             expect_code=1)
    assert node.stderr.decode("utf-8").splitlines()[0] == python.stderr.decode("utf-8").splitlines()[0]


def test_ocsf_record_without_valid_time_matches_node(tmp_path):
    """A record whose timestamp is not a real date keeps its place with time 0 (the chain is broken on
    purpose, so both exit 1)."""
    record = {
        "id": "ev_crafted", "timestamp": "2026-02-30T00:00:00Z", "agent_environment": "a", "phase": "p",
        "tool_name": "t", "payload_sha256": "0" * 64, "payload_preview": "x", "verdict": "allow",
        "rule": None, "reason": None, "confidence": 0.5, "latency_us": 3, "engine": "e",
        "prev_hash": "0" * 64, "record_hash": "1" * 64,
    }
    ledger = tmp_path / "crafted.jsonl"
    ledger.write_text(json.dumps(record) + "\n", encoding="utf-8")
    _same_export_and_manifest(tmp_path, ledger, "ocsf", [], expect_code=1)
    exported = (tmp_path / "py" / "out.txt").read_bytes()
    assert b'"time":0,' in exported
    assert b'"zn_time_unmapped":true' in exported
