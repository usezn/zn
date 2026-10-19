"""Measured coverage of credentials under prefixed variable names.

The Node.js tests (packages/zn-gate/test/prefixed_names_measured.test.js) run
the same forms. Values are synthetic and built from pieces.
"""

import unittest

from zn_gate import rules as R

VALUE = "Zx9" + "kQ2mN8pL" + "4rT6vW1y" + "Hc5J0"

CAUGHT = [
    "OPENAI_API_KEY=" + VALUE,
    "MY_APP_DB_PASSWORD=" + VALUE,
    "export X_SECRET=" + VALUE,
    "AWS_SECRET_ACCESS_KEY=" + VALUE,
    "MY_SERVICE_AUTH_TOKEN=" + VALUE,
    'export OPENAI_API_KEY="' + VALUE + '"',
    "OPENAI_API_KEY='" + VALUE + "'",
    "OPENAI_API_KEY = " + VALUE,
    "OPENAI_API_KEY: " + VALUE,
    '{"OPENAI_API_KEY": "' + VALUE + '"}',
    "env:\n  MY_APP_SECRET_KEY: " + VALUE,
    "- OPENAI_API_KEY=" + VALUE,
    "docker run -e OPENAI_API_KEY=" + VALUE + " img",
    "ENV OPENAI_API_KEY=" + VALUE,
    "set OPENAI_API_KEY=" + VALUE,
]

KEPT = [
    "OPENAI_API_KEY=YOUR_KEY_HERE_PLACEHOLDER",
    "OPENAI_API_KEY=<your-api-key-here-xxxx>",
    "OPENAI_API_KEY=${OPENAI_API_KEY_VALUE}",
    "MY_APP_DB_PASSWORD=$DB_PASSWORD_FROM_VAULT",
    "OPENAI_API_KEY=changeme",
    "OPENAI_API_KEY=",
    "const OPENAI_API_KEY = process.env.OPENAI_API_KEY_NAME_X;",
    "MAX_TOKEN_COUNT=1234567890123",
    "PASSWORD_MIN_LENGTH=1234567890123",
    "KEY_FILE_PATH=/etc/ssl/certs/ca-bundle.crt",
]


class TestPrefixedNamesMeasured(unittest.TestCase):
    def test_prefixed_names_are_redacted(self):
        for text in CAUGHT:
            with self.subTest(text=text[:30]):
                redacted, found = R.redact_secrets(text)
                self.assertNotIn(VALUE, redacted)
                self.assertTrue(found)

    def test_placeholders_references_and_settings_are_kept(self):
        for text in KEPT:
            with self.subTest(text=text[:30]):
                self.assertEqual(R.redact_secrets(text), (text, []))


if __name__ == "__main__":
    unittest.main()
