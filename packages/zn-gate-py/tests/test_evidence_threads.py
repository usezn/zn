"""Several threads in one process write to one ledger file."""

import json
import threading

from zn_gate.evidence import log_evidence, verify_evidence_ledger

THREADS = 8
PER_THREAD = 50


def test_threads_lose_no_entry_and_every_line_is_valid_json(tmp_path):
    path = str(tmp_path / "evidence.jsonl")
    results = []
    errors = []
    start = threading.Barrier(THREADS)

    def worker(wid):
        try:
            start.wait()
            for i in range(PER_THREAD):
                rec = log_evidence(
                    {"tool_name": "bash", "payload": f"fake-{wid}-{i}"},
                    path, lock_wait=60.0,
                )
                results.append(rec)
        except Exception as e:  # pragma: no cover - reported below
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(w,)) for w in range(THREADS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)

    assert not errors
    assert len(results) == THREADS * PER_THREAD
    assert all(r is not None for r in results)

    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().split("\n")
    assert lines[-1] == ""
    lines = lines[:-1]
    assert len(lines) == THREADS * PER_THREAD
    records = [json.loads(line) for line in lines]  # every line is valid JSON

    seen = {r["payload_preview"] for r in records}
    expected = {f"fake-{w}-{i}" for w in range(THREADS) for i in range(PER_THREAD)}
    assert seen == expected

    v = verify_evidence_ledger(path)
    assert v["valid"] is True
    assert v["total"] == THREADS * PER_THREAD
