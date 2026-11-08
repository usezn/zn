"""The Node and Python CSV evidence exports write the same header and the same row count for one ledger."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from zn_gate.evidence import export_evidence_ledger, log_evidence

NODE = shutil.which("node")
NODE_EVIDENCE = Path(__file__).resolve().parents[2] / "zn-gate" / "lib" / "evidence.js"

pytestmark = pytest.mark.skipif(
    NODE is None or not NODE_EVIDENCE.is_file(), reason="Node evidence module not available"
)

CSV_HEADER = (
    "timestamp,verdict,phase,tool_name,agent_environment,rule,reason,"
    "payload_sha256,record_hash,prev_hash,latency_us"
)


def _node_csv(path):
    script = (
        "const e = require(process.argv[1]);"
        "process.stdout.write(JSON.stringify(e.exportEvidenceLedger(process.argv[2], 'csv').content));"
    )
    env = dict(os.environ, NO_COLOR="1")
    r = subprocess.run(
        [NODE, "-e", script, str(NODE_EVIDENCE), str(path)],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.mark.parametrize("kind", ["empty", "one"])
def test_csv_header_and_row_count_match_node(tmp_path, kind):
    p = tmp_path / "evidence.jsonl"
    if kind == "empty":
        p.write_text("", encoding="utf-8")
    else:
        rec = log_evidence({"verdict": "allow", "phase": "pre", "tool_name": "example_tool"}, str(p))
        assert rec is not None
    py_lines = export_evidence_ledger(str(p), "csv")["content"].splitlines()
    node_lines = _node_csv(p).splitlines()
    assert py_lines[0] == CSV_HEADER
    assert node_lines[0] == py_lines[0]
    assert len(node_lines) == len(py_lines)
