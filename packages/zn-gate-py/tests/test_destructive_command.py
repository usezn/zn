"""The optional destructive-command policy, Python side: the corpus shared with the Node.js package (every
benign command allowed, every risky one blocked under the same rule), and the shape of the answer."""

import json
import time
import unittest
from pathlib import Path

import zn_gate
from zn_gate import Assessment, check_command
from zn_gate.destructive import COMMAND_RULES_VERSION

CORPUS_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "destructive_commands.json"
CORPUS = json.loads(CORPUS_FILE.read_text(encoding="utf-8"))


class DestructiveCommandCorpus(unittest.TestCase):
    def test_corpus_size(self):
        self.assertGreaterEqual(len(CORPUS["benign"]), 300)
        self.assertGreaterEqual(len(CORPUS["risky"]), 200)

    def test_no_benign_command_is_blocked(self):
        blocked = [c for c in CORPUS["benign"] if not check_command(c).allowed]
        self.assertEqual(blocked, [])

    def test_every_risky_command_is_blocked_under_its_rule(self):
        wrong = []
        for r in CORPUS["risky"]:
            res = check_command(r["cmd"])
            if res.allowed or res.rule != "destructive:" + r["rule"]:
                wrong.append((r["rule"], r["cmd"], res.rule))
        self.assertEqual(wrong, [])

    def test_shapes_outside_the_policy_are_allowed(self):
        self.assertEqual([x["cmd"] for x in CORPUS["not_covered"] if not check_command(x["cmd"]).allowed], [])


class DestructiveCommandShape(unittest.TestCase):
    def test_allow_and_block_answers(self):
        ok = check_command("npm test")
        self.assertIsInstance(ok, Assessment)
        self.assertTrue(ok.allowed)
        self.assertEqual(ok.rule, "none")
        bad = check_command("rm -rf ~")
        self.assertFalse(bad.allowed)
        self.assertEqual(bad.rule, "destructive:rm_root_home")
        self.assertTrue(bad.reason.startswith("Destructive command: "))
        self.assertEqual(bad.rules_version, COMMAND_RULES_VERSION)
        self.assertTrue(check_command(None).allowed)  # type: ignore[arg-type]

    def test_exported(self):
        self.assertIn("check_command", zn_gate.__all__)

    def test_hostile_long_input_stays_fast(self):
        inputs = ["a" * 100000, "curl " * 20000, "iwr " * 20000, '"\\"' * 30000, '"a ' * 30000, "; " * 40000,
                  "$( " * 30000, ":(){ " * 15000, "sh -c " * 15000, "echo " + "a" * 150000 + " && rm -rf ~"]
        for text in inputs:
            t0 = time.time()
            check_command(text)
            self.assertLess(time.time() - t0, 3, text[:12])

    def test_long_line_cannot_hide_a_command_after_the_segment_limit(self):
        for sep in (";", "\n"):
            long = ("true" + sep) * 5001 + "rm -rf ~"
            self.assertFalse(check_command(long).allowed, repr(sep))
        self.assertFalse(check_command("true;" * 5001 + "rm -rf ~").allowed)
        self.assertTrue(check_command("true;" * 5001).allowed)
        # past the segment limit the rest cannot be read, so the line is refused
        res = check_command("true;" * 60000)
        self.assertFalse(res.allowed)
        self.assertEqual(res.rule, "destructive:too_many_commands")

    def test_quoting_and_nesting(self):
        for c in ['rm -rf "~"', "rm -rf '/'", "rm -rf -- ~", "rm\t-rf\t~", "sh -c \"sh -c 'rm -rf ~'\""]:
            self.assertFalse(check_command(c).allowed, c)
        for c in ['echo "rm -rf ~"', "git commit -m \"rm -rf /\"", 'grep -r "dd of=/dev/sda" .']:
            self.assertTrue(check_command(c).allowed, c)


if __name__ == "__main__":
    unittest.main()
