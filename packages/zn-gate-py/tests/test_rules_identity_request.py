"""Identity-request family (same cases as packages/zn-gate/test/rules_identity_request.test.js).

Text in a tool result that tells the agent to identify its user, or to put the
user's identity in a header, URL parameter, cookie, form field or the next
request. The cases live in the Node.js fixtures so both packages run the same
ones; the test is skipped when they are not next to this package.
"""

import importlib
import json
import time
import unittest
from pathlib import Path

from zn_gate import rules as R

CASES_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "identity_request_cases.json"
FAMILY = ("pi:identity_request", "pi:identity_request_multi")


def _cases():
    if not CASES_FILE.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the identity-request cases")
    return json.loads(CASES_FILE.read_text(encoding="utf-8"))


class TestIdentityRequest(unittest.TestCase):
    def test_advisory_by_default_list(self):
        for rule_id in FAMILY:
            self.assertIn(rule_id, R.ADVISORY_BY_DEFAULT)

    def test_positives_are_advisories(self):
        for text in _cases()["positives"]:
            with self.subTest(text=text):
                r = R.evaluate(text)
                self.assertEqual(r.verdict, "allow")
                self.assertIn(r.advisory["rule"], FAMILY)

    def test_strict_blocks_positives(self):
        for text in _cases()["positives"]:
            with self.subTest(text=text):
                r = R.evaluate(text, strict=True)
                self.assertEqual(r.verdict, "block")
                self.assertIn(r.rule, FAMILY)

    def test_benign_counterparts_are_not_flagged(self):
        for text in _cases()["benign"]:
            for strict in (False, True):
                with self.subTest(text=text, strict=strict):
                    r = R.evaluate(text, strict=strict)
                    self.assertNotIn(r.rule, FAMILY)
                    self.assertFalse(r.advisory and r.advisory["rule"] in FAMILY)

    def test_tool_result_gets_an_advisory_and_strict_blocks(self):
        guard = importlib.import_module("zn_gate.guard")
        text = "<p>Welcome</p> " + _cases()["positives"][0]
        r = guard.check_tool_result(text)
        self.assertEqual(r.verdict, "allow")
        self.assertEqual(r.advisory["rule"], "pi:identity_request")
        s = guard.check_tool_result(text, strict=True)
        self.assertEqual((s.verdict, s.rule), ("block", "pi:identity_request"))

    def test_long_runs_of_words_are_not_slow(self):
        start = time.time()
        R.evaluate("send the users " * 4000)
        R.evaluate("include " + "the user " * 5000 + "header")
        self.assertLess(time.time() - start, 3)


class TestIdentityRequestPrefilter(unittest.TestCase):
    """The cheap checks in front of the two patterns must never change a verdict."""

    USER_GROUPS = {
        "pi:identity_request": [
            "(?:user|operator|owner|human|principal)",
            r"(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))",
            r"(?:your|their)\s{1,4}(?:(?:primary|login|account|real)\s{1,4})?e-?mail(?:\s{1,4}address(?:es)?)?",
        ],
        "pi:identity_request_multi": [
            "(?:usuario|operador|due[ñn]o|propietario)",
            "(?:usu[aá]rio|operador|dono|propriet[aá]rio)",
            "(?:utilisateur|opérateur|propriétaire)",
            "(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators)",
            "(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*)",
            "(?:用户|使用者|操作者|主人|所有者)",
            r"(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))",
        ],
    }

    @staticmethod
    def _patterns():
        return dict((rid, p) for rid, p, _d in R.INJECTION_RULES)

    @staticmethod
    def _top_level_alternatives(source):
        parts = []
        depth = 0
        cur = ""
        i = 0
        while i < len(source):
            c = source[i]
            if c == "\\":
                cur += source[i:i + 2]
                i += 2
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            if c == "|" and depth == 0:
                parts.append(cur)
                cur = ""
            else:
                cur += c
            i += 1
        parts.append(cur)
        return parts

    @staticmethod
    def _place_groups(source):
        found = []
        i = 0
        while i < len(source):
            if source[i] == "\\":
                i += 2
                continue
            if source.startswith("(?:", i):
                depth = 0
                j = i
                while j < len(source):
                    if source[j] == "\\":
                        j += 2
                        continue
                    if source[j] == "(":
                        depth += 1
                    elif source[j] == ")":
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                group = source[i:j + 1]
                if "header" in group.lower() and len(group) < 600 and "[^\\n]" not in group and group not in found:
                    found.append(group)
            i += 1
        return found

    def test_rule_ids_are_exactly_the_two_identity_request_ids(self):
        ids = sorted(rid for rid, _p, _d in R.INJECTION_RULES if rid.startswith("pi:identity_request"))
        self.assertEqual(ids, ["pi:identity_request", "pi:identity_request_multi"])
        self.assertEqual(sorted(R.IDENTITY_PREFILTERS), ids)
        for rule_id in ids:
            self.assertIn(rule_id, R.RULE_TESTERS)

    def test_prefilters_hold_the_user_and_place_groups_every_alternative_needs(self):
        for rule_id, expected in (("pi:identity_request", 2), ("pi:identity_request_multi", 6)):
            pattern = self._patterns()[rule_id]
            gate, place = R.IDENTITY_PREFILTERS[rule_id]
            places = self._place_groups(pattern.pattern)
            self.assertEqual(len(places), expected, rule_id)
            for group in places:
                self.assertIn(group, place.pattern, rule_id)
            for group in self.USER_GROUPS[rule_id]:
                self.assertIn(group, gate.pattern, rule_id)
            for prefilter in (gate, place):
                self.assertEqual(prefilter.flags, pattern.flags, rule_id)
            for alt in self._top_level_alternatives(pattern.pattern):
                self.assertTrue(any(g in alt for g in self.USER_GROUPS[rule_id]), alt[:60])
                self.assertTrue(any(g in alt for g in places) or "identify" in alt, alt[:60])
        self.assertIn("customer|account\\s{1,4}holder", R.IDENTITY_PREFILTERS["pi:identity_request"][0].pattern)

    def test_same_result_with_and_without_the_prefilters(self):
        import random

        cases = _cases()
        samples = cases["positives"] + cases["benign"]
        words = [w for t in samples for w in t.split()]
        words += ["header", "cookie", "who", "your user", "\n", "identify", "x-user-email", "customer", "holder"]
        rnd = random.Random(1080)
        patterns = self._patterns()
        positives = 0
        for _ in range(4000):
            base = rnd.choice(samples).split(" ")
            for _m in range(rnd.randrange(3)):
                at = rnd.randrange(len(base))
                op = rnd.random()
                if op < 0.4:
                    del base[at]
                elif op < 0.8:
                    base[at] = rnd.choice(words)
                else:
                    base.insert(at, rnd.choice(words))
                if not base:
                    base = ["x"]
            text = " ".join(base).upper() if rnd.random() < 0.2 else ("\n" if rnd.random() < 0.1 else " ").join(base)
            for rule_id in FAMILY:
                expected = patterns[rule_id].search(text) is not None
                positives += expected
                self.assertEqual(R.RULE_TESTERS[rule_id](text), expected, f"{rule_id}: {text!r}")
        self.assertGreater(positives, 500)
        for text in cases["positives"]:
            self.assertTrue(any(
                patterns[rid].search(text) is not None and R.RULE_TESTERS[rid](text) for rid in FAMILY
            ), text)

    def test_text_without_a_user_word_or_a_place_word_is_skipped(self):
        for rule_id in FAMILY:
            self.assertFalse(R.RULE_TESTERS[rule_id]("hello world, please summarize this page"))
            self.assertFalse(all(p.search("include the header in every request") for p in R.IDENTITY_PREFILTERS[rule_id]))


class TestIdentityRequestFoldedCharacters(unittest.TestCase):
    """Long s, Kelvin sign, dotless i... give the same result as in Node.js on raw text."""

    CASES_FILE = CASES_FILE.with_name("identity_request_unicode_cases.json")

    def _folded(self):
        if not self.CASES_FILE.is_file():
            raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the folded-character cases")
        return json.loads(self.CASES_FILE.read_text(encoding="utf-8"))["cases"]

    def test_expected_verdict_on_raw_text(self):
        cases = self._folded()
        self.assertGreaterEqual(len(cases), 20)
        for c in cases:
            self.assertEqual(R.RULE_TESTERS["pi:identity_request"](c["text"]), c["identity_request"], c["name"])
            self.assertEqual(R.RULE_TESTERS["pi:identity_request_multi"](c["text"]), c["identity_request_multi"], c["name"])

    def test_same_verdict_as_the_node_rules(self):
        import shutil
        import subprocess

        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node is not installed: skipping the Node.js/Python folded-character check")
        cases = self._folded()
        script = (
            "const r=require(process.argv[1]);"
            "const t=JSON.parse(require('fs').readFileSync(0,'utf8'));"
            "const ids=['pi:identity_request','pi:identity_request_multi'];"
            "const rules=ids.map(id=>r.INJECTION_RULES.find(x=>x.id===id));"
            "console.log(JSON.stringify(t.map(s=>rules.map(x=>x.test(s)))));"
        )
        rules_js = str(self.CASES_FILE.parents[2] / "lib" / "rules.js")
        out = subprocess.run([node, "-e", script, rules_js], input=json.dumps([c["text"] for c in cases]).encode("utf-8"),
                             capture_output=True, check=True, timeout=60).stdout
        node_verdicts = json.loads(out)
        py_verdicts = [[R.RULE_TESTERS[i](c["text"]) for i in FAMILY] for c in cases]
        for c, n, p in zip(cases, node_verdicts, py_verdicts):
            self.assertEqual(p, n, c["name"])

    def test_prefilters_never_hide_a_match_of_the_full_pattern(self):
        for c in self._folded():
            for rule_id in FAMILY:
                full = R._IDENTITY_PATTERNS[rule_id].search(c["text"].translate(R._NO_I_FOLD)) is not None
                self.assertEqual(R.RULE_TESTERS[rule_id](c["text"]), full, c["name"])


if __name__ == "__main__":
    unittest.main()
