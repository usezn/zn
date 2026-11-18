"""A whole number written with a fraction (5.0 for 5) is the same value: a ledger line that spells
it so verifies, as it does in the Node package. A changed value still fails."""
import json
import shutil
import subprocess
from pathlib import Path
import re

import pytest

from zn_gate.evidence import log_evidence, verify_evidence_ledger


def _respell(path, field, old, new):
    lines = path.read_text(encoding="utf-8").splitlines()
    pattern = '"%s":%s,' % (field, old)
    assert sum(line.count(pattern) for line in lines) >= 1, pattern
    out = [line.replace(pattern, '"%s":%s,' % (field, new), 1) if pattern in line else line for line in lines]
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def _ledger(tmp_path, n=1):
    p = tmp_path / "e.jsonl"
    for i in range(n):
        assert log_evidence({"tool_name": "t%d" % i, "latency_us": 5, "confidence": 1}, str(p)) is not None
    return p


def test_latency_written_as_five_point_zero_verifies(tmp_path):
    p = _ledger(tmp_path)
    _respell(p, "latency_us", "5", "5.0")
    assert '"latency_us":5.0,' in p.read_text(encoding="utf-8")
    assert verify_evidence_ledger(str(p))["valid"]


def test_confidence_written_as_one_point_zero_verifies(tmp_path):
    p = _ledger(tmp_path)
    _respell(p, "confidence", "1", "1.0")
    assert verify_evidence_ledger(str(p))["valid"]


def test_respelled_numbers_verify_across_a_chain(tmp_path):
    p = _ledger(tmp_path, n=3)
    lines = p.read_text(encoding="utf-8").splitlines()
    lines = [re.sub(r'"latency_us":5,', '"latency_us":5.0,', ln) for ln in lines]
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = verify_evidence_ledger(str(p))
    assert result["valid"] and result["total"] == 3


def test_changed_latency_value_still_fails(tmp_path):
    p = _ledger(tmp_path)
    _respell(p, "latency_us", "5", "6.0")
    result = verify_evidence_ledger(str(p))
    assert not result["valid"]
    assert "hash mismatch" in result["error"]


def test_fractional_latency_still_fails(tmp_path):
    p = _ledger(tmp_path)
    _respell(p, "latency_us", "5", "5.5")
    assert not verify_evidence_ledger(str(p))["valid"]


def test_boolean_confidence_is_not_taken_for_one(tmp_path):
    p = _ledger(tmp_path)
    _respell(p, "confidence", "1", "true")
    assert not verify_evidence_ledger(str(p))["valid"]


def test_unchanged_ledger_still_verifies(tmp_path):
    p = _ledger(tmp_path, n=2)
    assert verify_evidence_ledger(str(p))["valid"]
    # the file is still plain JSON lines
    for line in p.read_text(encoding="utf-8").splitlines():
        json.loads(line)


NODE = shutil.which("node")
NODE_EVIDENCE = Path(__file__).resolve().parents[2] / "zn-gate" / "lib" / "evidence.js"


@pytest.mark.skipif(NODE is None or not NODE_EVIDENCE.is_file(), reason="Node package not available")
def test_python_ledger_with_respelled_numbers_verifies_in_node(tmp_path):
    p = _ledger(tmp_path, n=2)
    _respell(p, "latency_us", "5", "5.0")
    _respell(p, "confidence", "1", "1.0")
    driver = tmp_path / "verify.js"
    driver.write_text(
        "const ev = require(process.argv[2]);\n"
        "process.stdout.write(JSON.stringify(ev.verifyEvidenceLedger(process.argv[3])));\n",
        encoding="utf-8",
    )
    out = subprocess.run([NODE, str(driver), str(NODE_EVIDENCE), str(p)],
                         check=True, capture_output=True, text=True, timeout=60)
    result = json.loads(out.stdout)
    assert result["valid"], result
    assert result["total"] == 2
    assert verify_evidence_ledger(str(p))["valid"]
