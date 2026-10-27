"""A quoted value with spaces under a secret key is redacted up to its closing
quote, a bare number under a quoted secret key is redacted without breaking
the JSON, and the scan stays linear. Same behaviour as the Node.js scrubber
(findQuotedKv in packages/zn-gate/lib/scrub/patterns.js). Fake values only."""

import json
import time
import unittest
from pathlib import Path

from zn_gate import redact_secrets
from zn_gate import rules as R
from zn_gate.rules import redact_scan_secrets

TOKEN = "[REDACTED_SECRET]"
FIXTURE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "scrub_quoted_kv_parity.json"


def redact(text: str) -> str:
    return redact_secrets(text)[0]


class QuotedCredentialTests(unittest.TestCase):
    def test_the_three_reported_inputs(self) -> None:
        self.assertEqual(redact('{"password":"abcdefgh ijk lmn","n":1}'), '{"password":"%s","n":1}' % TOKEN)
        self.assertEqual(redact('password="abcdefgh ijk lmn" x'), 'password="%s" x' % TOKEN)
        self.assertEqual(redact('{"token":12345678}'), '{"token":"%s"}' % TOKEN)

    def test_json_stays_valid(self) -> None:
        out = redact('{"password":"abcdefgh ijk lmn","n":1}')
        self.assertEqual(json.loads(out), {"password": TOKEN, "n": 1})
        self.assertEqual(json.loads(redact('{"token":12345678}')), {"token": TOKEN})
        for text in [
            '{"max_token":100000000,"x":1}',
            '{"params":{"arguments":{"page_token":123456789}}}',
            '{ "token" : -12345678.5 , "n" : null }',
            '{"api_key":1.2345678e10,"b":[1,2]}',
        ]:
            out = redact(text)
            self.assertNotEqual(out, text)
            self.assertIsInstance(json.loads(out), dict, out)
            for digits in ("12345678", "100000000", "123456789"):
                self.assertNotIn(digits, out)

    def test_shared_fixture_with_the_node_scrubber(self) -> None:
        """The same inputs and expected outputs as the Node.js scrubber ({S} is one replaced secret)."""
        if not FIXTURE.exists():
            self.skipTest("the monorepo fixture is not available (sdist)")
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 20)
        for case in cases:
            with self.subTest(case["name"]):
                self.assertEqual(redact(case["input"]), case["output"].replace("{S}", TOKEN))

    def test_escaped_json_string_inside_a_json_string(self) -> None:
        inner = '{"command":"echo {\\"password\\":\\"fake pass phrase here\\",\\"n\\":1}"}'
        out = redact(inner)
        self.assertNotIn("phrase", out)
        parsed = json.loads(out)
        self.assertEqual(list(parsed), ["command"])
        self.assertIn('"n":1', parsed["command"])
        out = redact('{"command":"echo {\\"token\\":12345678}"}')
        self.assertNotIn("12345678", out)
        json.loads(out)

    def test_escaped_quotes_are_part_of_the_value(self) -> None:
        out = redact('{"api_key":"fake key \\"with\\" quotes and spaces","n":1}')
        self.assertEqual(out, '{"api_key":"%s","n":1}' % TOKEN)
        json.loads(out)

    def test_left_alone(self) -> None:
        for text in [
            '{"password":"a b c","n":1}',
            '{"password":"your password here"}',
            '{"token":"${API TOKEN HERE}"}',
            'token: "Bearer ${TOKEN}"',
            '{"token":1234567}',
            '{"token":00000000}',
            '{"token":true,"password":null,"api_key":[1,2,3]}',
            '{"password_hint":"choose a long phrase","token_count":123456789}',
            '{"tokens":123456789,"max_tokens":100000000}',
            'password="unterminated value with spaces',
            "token=12345678 next",
            "password: 123456789012345",
        ]:
            with self.subTest(text):
                self.assertEqual(redact(text), text)

    def test_second_pass_changes_nothing(self) -> None:
        for text in ['{"password":"abcdefgh ijk lmn","n":1}', '{"token":12345678}', 'password="abcdefgh ijk lmn" x']:
            once = redact(text)
            self.assertEqual(redact(once), once, text)

    def test_detection_is_the_value_only(self) -> None:
        text = '{"password":"abcdefgh ijk lmn","n":1}'
        _, detections = redact_secrets(text)
        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0]["rule"], R.QUOTED_CREDENTIAL_RULE)
        self.assertEqual(text[detections[0]["start"]:detections[0]["end"]], "abcdefgh ijk lmn")
        num = '{"token":12345678}'
        _, detections = redact_secrets(num)
        self.assertEqual(num[detections[0]["start"]:detections[0]["end"]], "12345678")

    def test_the_rest_of_a_value_is_not_left_behind(self) -> None:
        # The assignment rules read one word; the quoted value is taken first, whole.
        self.assertEqual(redact('API_KEY="abcdefghijkl mno pqr" x'), 'API_KEY="%s" x' % TOKEN)
        self.assertEqual(redact('{"api_key":"abcdefghijkl mno pqr"}'), '{"api_key":"%s"}' % TOKEN)

    def test_invisible_characters(self) -> None:
        self.assertEqual(redact('{"pass​word":"abcdefgh ijk lmn"}'), '{"pass​word":"%s"}' % TOKEN)
        self.assertEqual(redact('{"password":"abcdefgh​ ijk lmn"}'), '{"password":"%s"}' % TOKEN)

    def test_scan_redaction_uses_it_too(self) -> None:
        out, detections = redact_scan_secrets('{"password":"abcdefgh ijk lmn","n":1}')
        self.assertEqual(out, '{"password":"%s","n":1}' % TOKEN)
        self.assertEqual(len(detections), 1)

    def test_value_past_the_length_cap_is_left_to_the_other_rules(self) -> None:
        text = '{"password":"' + "ab cd " * 2000 + '"}'
        self.assertEqual(redact(text), text)


def _elapsed(fn, text: str) -> float:
    t0 = time.perf_counter()
    fn(text)
    return time.perf_counter() - t0


class QuotedCredentialLinearTimeTests(unittest.TestCase):
    """The same adversarial inputs as the Node.js test, each under 3 seconds."""

    INPUTS = [
        'password="' * 50000,
        "token='" * 70000,
        '{"password":"' * 40000,
        '"password":\\"' * 40000,
        '"password":\\\\"' * 40000,
        'password="' + '\\"' * 200000,
        'password="' + "ab cd " * 100000,
        'token=\\" ' + 'token=\\\\" ' * 60000,
        "token:" + " " * 300000 + '"',
        "token " * 100000,
        '{"token":' + "1" * 300000 + "}",
        # Not in the Node.js list: a long run of backslashes inside and after the value.
        'password="' + "\\" * 300000,
        'token=\\"' + "\\" * 300000 + '"',
        "token='" + "\\" * 300000,
    ]

    def test_the_finder_is_linear(self) -> None:
        for text in self.INPUTS:
            took = _elapsed(R._redact_quoted_credentials, text)
            self.assertLess(took, 3.0, "took %.2f s on a %d-character input" % (took, len(text)))

    def test_redact_secrets_is_linear(self) -> None:
        for text in self.INPUTS:
            took = _elapsed(redact_secrets, text)
            self.assertLess(took, 3.0, "took %.2f s on a %d-character input" % (took, len(text)))

    def test_many_values_after_an_invisible_character(self) -> None:
        # One invisible character makes a second pass, whose spans are compared with
        # those of the first: 1 MiB of redactable members and of numbers.
        for member in ('"api_key":"q7a1b2c3d4e5f6a7b8",', '"token":12345678901,'):
            text = "\u200b" + member * (1024 * 1024 // len(member))
            took = _elapsed(redact_secrets, text)
            self.assertLess(took, 6.0, "took %.2f s on a %d-character input" % (took, len(text)))
            self.assertNotIn("q7a1b2c3", redact(text))
            self.assertNotIn("12345678901", redact(text))


if __name__ == "__main__":
    unittest.main()
