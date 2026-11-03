"""A secret split by shell quoting (AKIA""rest, 'a''b') or written with percent-encoding (%41KIA...,
api_key%3Dvalue) is redacted as a whole, a secret under a sensitive key inside a JSON string (backslash-escaped
quotes) and a secret in a URL query parameter are redacted, and ordinary quotes and %20 stay untouched. Same
behaviour as the Node.js scrubber (packages/zn-gate/lib/scrub/normalize.js, patterns.js); the cases of
packages/zn-gate/test/fixtures/scrub_normalised_parity.json are read by both. Fake values only."""

import json
import time
import unittest
from pathlib import Path

from zn_gate import redact_secrets
from zn_gate import rules as R
from zn_gate.rules import redact_scan_secrets

AWS = "AKIAIOSFODNN7EXAMPLE"
V = "fakeSecretValue1234"
ESC = '\\"'
SECRET = "[REDACTED_SECRET]"
AWS_TOKEN = "[REDACTED_AWS_KEY]"
FIXTURE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "scrub_normalised_parity.json"


def redact(text: str) -> str:
    return redact_secrets(text)[0]


def pct(s: str) -> str:
    return "".join("%%%02X" % ord(c) for c in s)


class ShellSplitTests(unittest.TestCase):
    def test_aws_key_split_by_shell_quotes_is_one_word(self) -> None:
        self.assertEqual(redact('echo AKIA""IOSFODNN7EXAMPLE'), "echo " + AWS_TOKEN)
        self.assertEqual(redact("echo 'AKIA''IOSFODNN7EXAMPLE'"), "echo '" + AWS_TOKEN + "'")
        self.assertEqual(redact('echo "AKIA""IOSFODNN7EXAMPLE"'), 'echo "' + AWS_TOKEN + '"')
        self.assertEqual(redact("echo AKIA''IOS''FODNN7EXAMPLE"), "echo " + AWS_TOKEN)

    def test_assignment_split_by_shell_quotes_is_redacted(self) -> None:
        for text in (
            "api_key='fakeSecret''Value1234'",
            'api_key=fakeSecret""Value1234',
            'api_key="fakeSecret""Value1234"',
            "export api_key='fake''Secret''Value1234'",
        ):
            out = redact(text)
            self.assertNotIn("Value1234", out, text)
            self.assertNotIn("fakeSecret", out, text)
            self.assertIn(SECRET, out, text)

    def test_detection_covers_the_whole_original_word(self) -> None:
        text = 'echo AKIA""IOSFODNN7EXAMPLE now'
        out, found = redact_secrets(text)
        self.assertEqual(out, "echo " + AWS_TOKEN + " now")
        self.assertEqual(found, [{"rule": "secret:aws_access_key", "start": 5, "end": 5 + len('AKIA""IOSFODNN7EXAMPLE')}])


class PercentEncodingTests(unittest.TestCase):
    def test_percent_encoded_values_are_redacted(self) -> None:
        self.assertEqual(redact("%41KIAIOSFODNN7EXAMPLE"), AWS_TOKEN)
        self.assertEqual(redact("key " + pct(AWS)), "key " + AWS_TOKEN)
        self.assertNotIn("akeSecret", redact("api_key=%66akeSecretValue1234"))
        self.assertNotIn("%", redact("api_key=" + pct(V)))
        self.assertNotIn(V, redact("api_key%3D" + V))
        out = redact("?x=1&api_key%3D" + pct(V))
        self.assertNotIn("%66", out)
        self.assertTrue(out.startswith("?x=1&api_key"), out)
        self.assertIn(SECRET, out)

    def test_ordinary_quotes_empty_strings_and_encoded_spaces_are_untouched(self) -> None:
        for text in (
            'echo "hello" "world"',
            "echo 'a' 'b'",
            '{"name": "", "x": ""}',
            'echo ""',
            "GET /a%20b/c%20d?q=hello%20world HTTP/1.1",
            "https://example.com/search?q=a%2Fb%26c",
            "path=C:%5CUsers%5Cdemo",
            "discount is 50% off",
            "bad %zz and %4",
        ):
            self.assertEqual(redact(text), text, text)
            self.assertEqual(redact_scan_secrets(text)[0], text, text)

    def test_the_scan_rules_read_the_view_too(self) -> None:
        self.assertEqual(redact_scan_secrets('echo AKIA""IOSFODNN7EXAMPLE')[0], "echo " + AWS_TOKEN)
        out = redact_scan_secrets("--api-key=%66akeSecretValue1234")[0]
        self.assertNotIn("akeSecret", out)


class EscapedQuoteAssignmentTests(unittest.TestCase):
    def test_assignment_inside_a_json_string_is_redacted(self) -> None:
        forms = (
            '{"cmd": "export api_key=' + ESC + V + ESC + '"}',
            '{"cmd": "API_KEY=' + ESC + V + ESC + ' node app.js"}',
            '{"body": "{' + ESC + "api_key" + ESC + ": " + ESC + V + ESC + '}"}',
            "curl -d '{" + ESC + "client_secret" + ESC + ":" + ESC + V + ESC + "}'",
            'export token=\\\\"' + V + '\\\\"',
        )
        for text in forms:
            self.assertNotIn(V, redact(text), text)
        self.assertEqual(
            redact('{"cmd": "export api_key=' + ESC + V + ESC + '"}'),
            '{"cmd": "export api_key=' + ESC + SECRET + ESC + '"}',
        )

    def test_placeholders_short_values_and_other_names_stay(self) -> None:
        for text in (
            '{"cmd": "export api_key=' + ESC + "short" + ESC + '"}',
            '{"cmd": "export api_key=' + ESC + "your-api-key-here" + ESC + '"}',
            '{"cmd": "export api_key=' + ESC + "${API_KEY_VALUE}" + ESC + '"}',
            '{"cmd": "export log_level=' + ESC + V + ESC + '"}',
        ):
            self.assertEqual(redact(text), text, text)


class QueryParameterTests(unittest.TestCase):
    def test_query_parameter_is_redacted_up_to_the_next_delimiter(self) -> None:
        cases = (
            ("https://example.com/p?api_key=" + V + "&x=1", "https://example.com/p?api_key=" + SECRET),
            ("https://example.com/p?x=1&token=" + V, "https://example.com/p?x=1&token=" + SECRET),
            ("https://example.com/p?access_token=" + V + "#frag", "https://example.com/p?access_token=" + SECRET + "#frag"),
            ("GET /v1/items?client_secret=" + V + " HTTP/1.1", "GET /v1/items?client_secret=" + SECRET + " HTTP/1.1"),
            ('"https://example.com/p?apikey=' + V + '"', '"https://example.com/p?apikey=' + SECRET + '"'),
        )
        for text, want in cases:
            out = redact(text)
            self.assertNotIn(V, out, text)
            self.assertIn(SECRET, out, text)
            if "&x=1" not in text:
                self.assertEqual(out, want, text)

    def test_benign_parameters_short_and_placeholder_values_stay(self) -> None:
        for text in (
            "https://example.com/p?page=2&sort=name&q=fakeSecretValue1234",
            "https://example.com/p?token=short",
            "https://example.com/p?api_key=your-api-key-here",
            "https://example.com/p?api_key=${API_KEY_FROM_ENV}",
            "https://example.com/p?token=%7B%7Btoken_value%7D%7D",
            "https://example.com/p?next=/login&password_min_length=12",
            "https://example.com/p?key=" + V,
            "https://example.com/p?token=some-descriptive-token-name",
        ):
            self.assertEqual(redact(text), text, text)


class NormalisedViewTests(unittest.TestCase):
    def test_the_view_decodes_only_printable_ascii_and_keeps_percent_20(self) -> None:
        self.assertIsNone(R.normalised_view("a%20b"))
        self.assertIsNone(R.normalised_view("a%00b%C3%A9"))
        view = R.normalised_view("x%41y")
        assert view is not None
        clean, starts, ends = view
        self.assertEqual(clean, "xAy")
        self.assertEqual((starts[1], ends[1]), (1, 4))
        self.assertEqual((starts[3], ends[3]), (5, 5))
        view = R.normalised_view("a''b")
        assert view is not None
        self.assertEqual(view[0], "ab")
        self.assertIsNone(R.normalised_view("''a"))
        self.assertIsNone(R.normalised_view("a'''b"))

    def test_decoding_is_capped_and_linear(self) -> None:
        big = "%41" * (R.MAX_NORMALISE_DECODES + 50000)
        t0 = time.perf_counter()
        view = R.normalised_view(big)
        assert view is not None
        self.assertEqual(len(view[0]), R.MAX_NORMALISE_DECODES + 50000 * 3)
        long = ("a''" * 200000) + "%41" * 100000
        redact_secrets(long)
        self.assertLess(time.perf_counter() - t0, 15.0)


class LinearTimeTests(unittest.TestCase):
    def test_the_new_rules_stay_linear_on_hostile_input(self) -> None:
        for text in (
            "?" + "a" * 200000 + "token",
            "&" + "token_" * 40000,
            "api_key=" + "\\" * 200000,
            "api_key" + '\\"' * 100000,
            "?api_key=" + "A1b2" * 100000,
        ):
            t0 = time.perf_counter()
            redact_secrets(text)
            took = time.perf_counter() - t0
            self.assertLess(took, 5.0, "took %.2f s on a %d-character input" % (took, len(text)))


class NodeParityFixtureTests(unittest.TestCase):
    """The cases of the fixture the Node.js scrubber test reads: redacted or not, the engines agree."""

    def test_shared_fixture(self) -> None:
        if not FIXTURE.exists():
            self.skipTest("packages/zn-gate is not next to this package")
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 40)
        for case in cases:
            out, found = redact_secrets(case["input"])
            self.assertEqual(out != case["input"], case["redacted"], case["name"])
            self.assertEqual(bool(found), case["redacted"], case["name"])
            scanned = redact_scan_secrets(case["input"])[0]
            self.assertEqual(scanned != case["input"], case["redacted"], case["name"] + " (scan)")


if __name__ == "__main__":
    unittest.main()
