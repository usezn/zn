"""The Node and Python packages write the same evidence record for the same event, and a ledger
written by one verifies with the other."""
import json
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
