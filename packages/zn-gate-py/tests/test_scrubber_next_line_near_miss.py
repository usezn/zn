"""Near-miss negatives for a fake key followed by a hyphenated or dotted word on the next line (`run-deploy`,
`config.yaml`). Same fixture as test/scrub_next_line_near_miss.test.js: fake keys in 5-character chunks, assembled
here; ideal_py is the output for the key line alone plus the next line verbatim; py_over records the cases where
the Python engine still takes part of the next line. A case whose state changes fails, in both directions.
The Python engine is also compared with Node (ideal_node, node_over) so a parity change shows up here."""
import json
import unittest
from pathlib import Path

from zn_gate.rules import redact_secrets

FIXTURE = (Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures"
           / "scrubber_next_line_near_miss.json")
CORPUS = json.loads(FIXTURE.read_text(encoding="utf-8")) if FIXTURE.exists() else None


def _assemble(key):
    return "".join(CORPUS["keys"][key]["prefix_chunks"]) + "".join(CORPUS["keys"][key]["body_chunks"])


@unittest.skipIf(CORPUS is None, "needs the monorepo checkout")
class NextLineNearMiss(unittest.TestCase):
    def test_size(self):
        self.assertGreaterEqual(len(CORPUS["cases"]), 1000)

    def test_each_case_matches_its_recorded_state(self):
        wrong = []
        for c in CORPUS["cases"]:
            line = c["prefix"] + _assemble(c["key"])
            out = redact_secrets(line + c["sep"] + c["next"])[0]
            line_out = redact_secrets(line)[0]
            if line_out + c["sep"] + c["next"] != c["ideal_py"]:
                wrong.append(("ideal", c["key"], c["next"]))
            if (out != c["ideal_py"]) != c["py_over"]:
                wrong.append(("state", c["key"], c["next"], out))
            body = "".join(CORPUS["keys"][c["key"]]["body_chunks"])
            for i in range(len(body) - 7):
                if body[i:i + 8] in out and body[i:i + 8] not in line_out:
                    wrong.append(("new_leak", c["key"], c["next"]))
                    break
        self.assertEqual(wrong[:5], [])

    def test_engines_differ_only_where_recorded(self):
        # Where neither engine over-redacts, both give the same output; where they do, the over-redaction is recorded.
        for c in CORPUS["cases"]:
            if not c["node_over"] and not c["py_over"]:
                self.assertEqual(c["ideal_node"], c["ideal_py"], (c["key"], c["next"]))


if __name__ == "__main__":
    unittest.main()
