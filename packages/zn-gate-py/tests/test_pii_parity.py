"""The Python PII layer (zn_gate.pii) must find what the Node.js PII layer finds.

The same fictitious inputs go through Node.js (packages/zn-gate/test/helpers/export_pii.js, the
scrubber engine restricted to PII spans) and through zn_gate.find_pii; the types, values and
positions must be equal. These tests need the monorepo checkout and a `node` binary; they are
skipped with a message when either is missing (for example when testing an sdist). Fake data only.
"""

import json
import random
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from zn_gate import find_pii, redact_pii
from zn_gate import pii as P

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
EXPORT_SCRIPT = NODE_PKG / "test" / "helpers" / "export_pii.js"

EMAIL = "jane@example.com"
PHONE = "+442071838750"
PHONE_US = "+14155552671"
IBAN = "GB82WEST12345698765432"
IBAN_DE = "DE89370400440532013000"
CARD = "4111111111111111"
CARD_MC = "5555555555554444"
CARD_AMEX = "378282246310005"
DNI = "12345678Z"
NIE = "X1234567L"
SSN = "078-05-1120"
IP = "93.184.216.34"

CASES = [
    {"text": "Contact " + EMAIL + " today"},
    {"text": "Call " + PHONE + " now"},
    {"text": "Call " + PHONE_US + " now"},
    {"text": "Call (212) 555-0100 now"},
    {"text": "Call +1 212 555 0100 now"},
    {"text": "IBAN: " + IBAN + " please"},
    {"text": "IBAN: GB82 WEST 1234 5698 7654 32 please"},
    {"text": "IBAN: " + IBAN_DE + "."},
    {"text": "IBAN: GB82WEST12345698765433 bad checksum"},
    {"text": "Card " + CARD + " exp 12/30"},
    {"text": "Card 4111 1111 1111 1111 ok"},
    {"text": "Card 4111-1111-1111-1111 ok"},
    {"text": "Card 4111 1111-1111 1111 mixed"},
    {"text": "Card " + CARD_MC + " and " + CARD_AMEX},
    {"text": "Card 4111111111111112 bad luhn"},
    {"text": "Card 0000000000000000 zeros"},
    {"text": "DNI " + DNI + " NIE " + NIE},
    {"text": "DNI 12345678A wrong letter"},
    {"text": "SSN " + SSN + " on file"},
    {"text": "SSN 666-12-3456 and 900-12-3456 and 123-00-4567"},
    {"text": "Server " + IP + " and 10.0.0.1 and 192.168.1.1 and 203.0.113.5"},
    {"text": "Server " + IP, "pii": {"ipv4": True}},
    {"text": "Server " + IP + " " + EMAIL, "pii": {"email": False}},
    {"text": "Server " + IP + " " + EMAIL, "pii": False},
    {"text": EMAIL + " " + PHONE + " " + CARD, "pii": {"phone": False, "card": False}},
    # keyed fields
    {"text": "X-User-Name: Jane Example"},
    {"text": "/submit?name=Jane+Example&x=1"},
    {"text": "-H 'X-User-Name: Jane Example'"},
    {"text": "{\"X-User-Name\": \"Jane Example\"}"},
    {"text": "name=Jane Example\nemail=" + EMAIL + "\niban=" + IBAN},
    {"text": "name=build output"},
    {"text": "name=Jane"},
    {"text": "X-Full-Name: Jane"},
    {"text": "X-Full-Name: José García"},
    {"text": "/submit?full_name=Jos%C3%A9+Garc%C3%ADa&x=1"},
    {"text": "/submit?full_name=Jos%zz+Garc&x=1"},
    {"text": "Her name is Jane Example."},
    {"text": "X-Address: 1 Example Street"},
    {"text": "/ship?address=1+Example+Street&zip=1"},
    {"text": "address=1 Example Street, Springfield"},
    {"text": "Ship to 1 Example Street, Springfield"},
    {"text": "X-Username: jane_example"},
    {"text": "/login?username=jane_example&x=1"},
    {"text": "/login?user=root&x=1"},
    {"text": "USER=jane_example"},
    {"text": "user=jane_example"},
    {"text": "login=3f2504e0-4f89-11d3-9a0c-0305e82c3301"},
    {"text": "user jane_example logged in"},
    {"text": "X-Forwarded-User: jane_example\nX-Remote-User: jane.example"},
    {"text": "X-User-Name: Jane Example", "pii": {"name": False}},
    {"text": "X-Username: jane_example", "pii": {"username": False}},
    {"text": "X-Address: 1 Example Street", "pii": {"address": False}},
    {"text": "X-User-Name: <name>\nname=${NAME}\nname=null"},
    # e-mail edges
    {"text": "https://jane@example.com/path and ssh://jane@example.com:22"},
    {"text": "jane@example.com:8080 and jane@example.png and git@github.com and noreply@example.com"},
    {"text": "jane@example.internal and jane@..example.com and a..b@example.com"},
    {"text": "@decorator and x@y and a@b.co"},
    # invisible characters and wrapped values
    {"text": "ja​ne@example.com"},
    {"text": "Card 4111​1111​1111​1111 ok"},
    {"text": "IBAN: GB82WEST1234569\n8765432 wrapped"},
    # overlaps and non-ASCII context
    {"text": "éè " + EMAIL + " 你好 " + PHONE + " \U0001F600 " + CARD},
    {"text": CARD + CARD},
    {"text": PHONE + PHONE_US},
    {"text": ""},
    {"text": "no personal data here at all"},
]

FRAGMENTS = [
    EMAIL, PHONE, PHONE_US, IBAN, IBAN[:10], IBAN_DE, CARD, CARD[:8], CARD_MC, CARD_AMEX, DNI, NIE, SSN, IP, "10.1.2.3",
    "X-User-Name: Jane Example", "X-Address: 1 Example Street", "X-Username: jane_example", "name=Jane Example",
    "?user=jane_example&", "address=1 Example Street", "full_name=Jos%C3%A9+Garc%C3%ADa", "user=root",
    " ", " ", "\t", "\n", "\n", "\r\n", ",", ".", "-", "+", "@", "_", "x", "abc", "0", "1234", "​", "é", "'", '"',
    "://", ":", "&", "?", "=", "Name=", "NAME=",
]


def _fuzz_cases(count=400, seed=2310):
    rnd = random.Random(seed)
    cases = []
    for _ in range(count):
        text = "".join(rnd.choice(FRAGMENTS) for _ in range(rnd.randint(1, 9)))
        case = {"text": text}
        if rnd.random() < 0.15:
            case["pii"] = {"ipv4": True}
        cases.append(case)
    return cases


_NODE = None


def _node_run(cases):
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed: skipping the Node.js/Python PII parity check")
    if not EXPORT_SCRIPT.is_file():
        raise unittest.SkipTest("packages/zn-gate is not next to this package: skipping the PII parity check")
    if not (NODE_PKG / "lib" / "scrub" / "engine.js").is_file():
        raise unittest.SkipTest("packages/zn-gate has no scrubber: skipping the PII parity check")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "cases.json"
        src.write_text(json.dumps(cases), encoding="utf-8")
        # Run from an empty directory so no .znrules / zn.config.json is picked up.
        proc = subprocess.run([node, str(EXPORT_SCRIPT), str(src)], cwd=tmp, capture_output=True, text=True,
                              encoding="utf-8", timeout=180)
    if proc.returncode != 0:
        raise unittest.SkipTest("node could not run the PII export (run npm ci in packages/zn-gate): " + proc.stderr[-300:])
    return json.loads(proc.stdout)


def _node_all():
    global _NODE
    if _NODE is None:
        cases = CASES + _fuzz_cases()
        _NODE = (cases, _node_run(cases))
    return _NODE


def _cp_index(text, utf16_index):
    """Python index of a UTF-16 index (Node.js counts UTF-16 units)."""
    return len(text.encode("utf-16-le")[:2 * utf16_index].decode("utf-16-le"))


def _node_spans(text, spans):
    return [(s["type"], _cp_index(text, s["start"]), _cp_index(text, s["end"]), s["value"]) for s in spans]


def _py_spans(case):
    text = case["text"]
    kwargs = {"pii": case["pii"]} if "pii" in case else {}
    return [(s["type"], s["start"], s["end"], text[s["start"]:s["end"]]) for s in find_pii(text, **kwargs)]


class TestPiiParity(unittest.TestCase):
    def test_types_defaults_and_version_match(self):
        _, node = _node_all()
        self.assertEqual(node["types"], P.PII_TYPES)
        self.assertEqual(node["defaults"], P.PII_DEFAULTS)
        self.assertEqual(node["version"], P.PII_RULES_VERSION)

    def test_fixed_cases_find_the_same_spans(self):
        cases, node = _node_all()
        for case, expected in zip(cases[:len(CASES)], node["results"][:len(CASES)], strict=True):
            with self.subTest(text=case["text"], pii=case.get("pii")):
                self.assertEqual(_py_spans(case), _node_spans(case["text"], expected))

    def test_seeded_random_texts_find_the_same_spans(self):
        cases, node = _node_all()
        found = 0
        for case, expected in zip(cases[len(CASES):], node["results"][len(CASES):], strict=True):
            with self.subTest(text=case["text"], pii=case.get("pii")):
                self.assertEqual(_py_spans(case), _node_spans(case["text"], expected))
            found += len(expected)
        self.assertGreater(found, 100)  # the generator really produces personal data

    def test_every_type_is_exercised(self):
        cases, node = _node_all()
        seen = {s["type"] for spans in node["results"] for s in spans}
        self.assertEqual(seen, set(P.PII_TYPES))


class TestPiiBehaviour(unittest.TestCase):
    """Stand-alone checks (no Node.js needed)."""

    def test_the_example_values_are_found(self):
        text = f"{EMAIL} {PHONE} {IBAN} {CARD} {DNI} {SSN}"
        types = [s["type"] for s in find_pii(text)]
        self.assertEqual(types, ["EMAIL", "PHONE", "IBAN", "CARD", "DNI", "SSN"])

    def test_ipv4_is_off_by_default(self):
        self.assertEqual(find_pii("host " + IP), [])
        self.assertEqual([s["type"] for s in find_pii("host " + IP, {"ipv4": True})], ["IPV4"])

    def test_pii_false_detects_nothing(self):
        self.assertEqual(find_pii(EMAIL + " " + CARD, False), [])

    def test_a_name_needs_its_key(self):
        self.assertEqual(find_pii("Her name is Jane Example."), [])
        spans = find_pii("X-User-Name: Jane Example")
        self.assertEqual([(s["type"], s["start"], s["end"]) for s in spans], [("PERSON_NAME", 13, 25)])

    def test_redact_uses_the_node_marker(self):
        out, spans = redact_pii("mail " + EMAIL + " card " + CARD)
        self.assertEqual(out, "mail __ZN_REDACTED_EMAIL__ card __ZN_REDACTED_CARD__")
        self.assertEqual(len(spans), 2)

    def test_redact_leaves_clean_text_alone(self):
        text = "nothing personal"
        self.assertEqual(redact_pii(text), (text, []))

    def test_a_value_split_by_a_zero_width_character_is_found(self):
        out, _ = redact_pii("ja​ne@example.com")
        self.assertNotIn("example.com", out)

    def test_validators(self):
        self.assertTrue(P.luhn_valid(CARD))
        self.assertFalse(P.luhn_valid("4111111111111112"))
        self.assertTrue(P.iban_valid(IBAN))
        self.assertTrue(P.iban_valid("GB82 WEST 1234 5698 7654 32"))
        self.assertFalse(P.iban_valid("GB82WEST12345698765433"))
        self.assertTrue(P.e164_valid(PHONE))
        self.assertFalse(P.e164_valid("+1234567890123"))

    def test_a_long_run_of_spaces_after_a_header_prefix_is_fast(self):
        import time
        t0 = time.time()
        find_pii("X-abcd" + " " * 100000)
        self.assertLess(time.time() - t0, 5)

    def test_text_must_be_a_string(self):
        with self.assertRaises(TypeError):
            find_pii(b"x")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
