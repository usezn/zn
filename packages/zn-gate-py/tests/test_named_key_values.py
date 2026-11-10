"""Secret-named keys written in lower case, mixed case, dotted or dashed form.

openai_api_key=, my.app.db.password= and github-token= are redacted like their
upper-case forms; a short, low-entropy, placeholder or reference value is kept.
The same fixture is read by the Node.js scrubber (test/scrub_named_keys.test.js).
Fake values only.
"""

import json
import unittest
from pathlib import Path

from zn_gate.rules import redact_secrets

TOKEN = "[REDACTED_SECRET]"
FIXTURE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "scrub_named_key_parity.json"


def redact(text: str) -> str:
    return redact_secrets(text)[0]


class NamedKeyValueTests(unittest.TestCase):
    def test_shared_fixture_with_the_node_scrubber(self) -> None:
        if not FIXTURE.exists():
            self.skipTest("the monorepo fixture is not available")
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 30)
        for case in cases:
            self.assertEqual(redact(case["input"]), case["output"].replace("{S}", TOKEN), case["name"])

    def test_detection_names_the_rule_and_the_value_span(self) -> None:
        text = "my.app.db.password=Zx9fQ2mK7vLp3Rt8"
        out, found = redact_secrets(text)
        self.assertEqual(out, "my.app.db.password=" + TOKEN)
        self.assertEqual([(d["rule"], d["start"], d["end"]) for d in found], [("secret:named_key_value", 19, 35)])

    def test_a_long_input_without_secret_keys_is_unchanged(self) -> None:
        text = "a.b.c.d-e.f_g=" + "x" * 10 + "\n"
        self.assertEqual(redact(text * 2000), text * 2000)


if __name__ == "__main__":
    unittest.main()
