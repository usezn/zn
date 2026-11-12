"""The Python destructive-command check against the benign everyday-command corpus of the Node package.

The corpus is packages/zn-gate/test/fixtures/benign-commands.txt (one command per line, fictional hosts and paths;
the strings are only analysed, never run). Node's decision for each line is in benign-commands.expected.json,
written by test/fixtures/make_benign_expected.js and kept fresh by a Node test, so this test needs no Node.
"""

import json
import unittest
from pathlib import Path

from zn_gate import check_command

FIXTURES = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures"
MIN_ALLOW_RATE = 0.99

COMMANDS = [x for x in FIXTURES.joinpath("benign-commands.txt").read_text(encoding="utf-8").split("\n") if x.strip()]
EXPECTED = json.loads(FIXTURES.joinpath("benign-commands.expected.json").read_text(encoding="utf-8"))

# Lines where Python and Node differ on purpose. Each entry needs a comment saying why.
KNOWN_DIFFERENCES = {}


def _rule(res):
    return None if res.allowed else str(res.rule).replace("destructive:", "")


class BenignCorpusParity(unittest.TestCase):
    def test_expected_file_covers_the_corpus(self):
        self.assertEqual([e["cmd"] for e in EXPECTED], COMMANDS)

    def test_allow_rate(self):
        blocked = [(c, _rule(check_command(c))) for c in COMMANDS if not check_command(c).allowed]
        rate = (len(COMMANDS) - len(blocked)) / len(COMMANDS)
        print("python allow rate on the benign corpus: %.4f (%d of %d)" % (rate, len(COMMANDS) - len(blocked), len(COMMANDS)))
        self.assertGreaterEqual(rate, MIN_ALLOW_RATE, blocked)

    def test_same_decision_as_node(self):
        diff = []
        for e in EXPECTED:
            res = check_command(e["cmd"])
            got = (("allow" if res.allowed else "block"), _rule(res))
            want = (e["destructive"], (e["rule"] or "").replace("destructive:", "") or None)
            if got != want and e["cmd"] not in KNOWN_DIFFERENCES:
                diff.append({"cmd": e["cmd"], "python": got, "node": want})
        self.assertEqual(diff, [])


if __name__ == "__main__":
    unittest.main()
