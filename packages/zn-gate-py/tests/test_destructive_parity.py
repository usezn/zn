"""Node.js / Python parity for the destructive-command policy, line by line.

Every line of the shared corpus (zn-gate/test/fixtures/destructive_commands.json: benign, risky and not_covered) goes
through both implementations. The Python answer must match the corpus label and, when Node is installed, the Node answer
(verdict, rule, reason, confidence and rules version). A mismatch fails with one message per line. The command strings are
test data and are never run."""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from zn_gate import check_command
from zn_gate.destructive import COMMAND_RULES_VERSION

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
CORPUS = json.loads((NODE_PKG / "test" / "fixtures" / "destructive_commands.json").read_text(encoding="utf-8"))
NODE = shutil.which("node")

# Lines where Node and Python are known to differ: command -> board task id. Empty means full parity.
KNOWN_DIFFERENCES: dict = {}

# Not in the corpus: an unknown flag and empty commands.
EXTRA = ["ls --zn-unknown-flag", "rm -rf --zn-unknown-flag ~", "", "   "]

NODE_SCRIPT = (
    "const {checkCommand,RULES}=require(process.argv[1]+'/lib/destructive');"
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d).map(c=>{const r=checkCommand(c);"
    "return [r.verdict,r.rule,r.reason,r.confidence,r.rules_version]});"
    "process.stdout.write(JSON.stringify({rules:RULES,out:o}))})"
)


def _py(cmd):
    r = check_command(cmd)
    return [r.verdict, r.rule, r.reason, r.confidence, r.rules_version]


def _all_commands():
    cmds = list(CORPUS["benign"]) + [r["cmd"] for r in CORPUS["risky"]] + [x["cmd"] for x in CORPUS["not_covered"]]
    return cmds + EXTRA


def _run_node(cmds):
    proc = subprocess.run([NODE, "-e", NODE_SCRIPT, str(NODE_PKG)], input=json.dumps(cmds), capture_output=True,
                          text=True, encoding="utf-8", timeout=120, check=True)
    return json.loads(proc.stdout)


class CorpusLineExpectations(unittest.TestCase):
    """Python against the labels in the corpus, with one message per wrong line."""

    def test_every_line_matches_its_label(self):
        wrong = []
        for cmd in CORPUS["benign"] + [x["cmd"] for x in CORPUS["not_covered"]]:
            if cmd not in KNOWN_DIFFERENCES and not check_command(cmd).allowed:
                wrong.append("expected allow, python says %s: %r" % (check_command(cmd).rule, cmd))
        for r in CORPUS["risky"]:
            if r["cmd"] in KNOWN_DIFFERENCES:
                continue
            got = check_command(r["cmd"])
            if got.allowed or got.rule != "destructive:" + r["rule"]:
                wrong.append("expected destructive:%s, python says %s: %r" % (r["rule"], got.rule, r["cmd"]))
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))


@unittest.skipUnless(NODE, "node is not installed")
class NodePythonParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cmds = _all_commands()
        cls.node = _run_node(cls.cmds)

    def test_same_answer_on_every_line(self):
        diffs = []
        for i, (cmd, n) in enumerate(zip(self.cmds, self.node["out"])):
            p = _py(cmd)
            if p != n and cmd not in KNOWN_DIFFERENCES:
                diffs.append("line %d: node=%s python=%s command=%r" % (i, n[:2], p[:2], cmd))
        self.assertEqual(diffs, [], "Node and Python disagree on %d line(s):\n%s" % (len(diffs), "\n".join(diffs)))

    def test_known_differences_still_differ(self):
        # A fixed difference must leave the list, so the list never hides a regression.
        for cmd, board_id in KNOWN_DIFFERENCES.items():
            self.assertNotEqual(_py(cmd), _run_node([cmd])["out"][0], "%s is fixed: remove %r" % (board_id, cmd))

    def test_same_rule_ids_and_version(self):
        rules = {"destructive:" + r for r in ("rm_root_home", "pipe_to_shell", "disk_overwrite", "perm_root", "fork_bomb", "rc_download")}
        self.assertEqual(set(self.node["rules"]), rules)
        self.assertEqual({n[4] for n in self.node["out"]}, {COMMAND_RULES_VERSION})


class EachRuleDirect(unittest.TestCase):
    """Each rule id, straight from the corpus: its first and last risky example, blocked under that rule."""

    def test_each_rule_id_blocks_its_examples(self):
        by_rule = {}
        for r in CORPUS["risky"]:
            by_rule.setdefault(r["rule"], []).append(r["cmd"])
        self.assertEqual(set(by_rule), {"rm_root_home", "pipe_to_shell", "disk_overwrite", "perm_root", "fork_bomb", "rc_download"})
        for rule, cmds in by_rule.items():
            for cmd in (cmds[0], cmds[-1]):
                with self.subTest(rule=rule, cmd=cmd):
                    got = check_command(cmd)
                    self.assertEqual((got.verdict, got.rule), ("block", "destructive:" + rule))
                    self.assertTrue(got.reason.startswith("Destructive command: "))

    def test_unknown_flag_is_allowed_and_not_a_crash(self):
        self.assertTrue(check_command("ls --zn-unknown-flag").allowed)
        self.assertIsInstance(check_command("rm -rf --zn-unknown-flag ~").verdict, str)

    def test_empty_command_is_allowed(self):
        for cmd in ("", "   "):
            got = check_command(cmd)
            self.assertEqual((got.verdict, got.rule), ("allow", "none"))


if __name__ == "__main__":
    unittest.main()
