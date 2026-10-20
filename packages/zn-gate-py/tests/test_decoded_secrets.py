"""Secrets inside base64, inside JSON unicode escapes and assembled by simple shell
expansions are redacted; ordinary base64 and escapes without a secret are not
(see test/scrub_decoded_secrets.test.js)."""
import base64
import os
import unittest

from zn_gate import rules as R

# Fictitious GitHub token: "ghp_" + 36 characters.
KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
AWS = 'AKIAIOSFODNN7EXAMPLE'
BS = chr(92)


def esc(s: str) -> str:
    return ''.join(BS + 'u00%02x' % ord(c) for c in s)


def b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


class DecodedSecrets(unittest.TestCase):
    def redact(self, text: str) -> str:
        return R.redact_secrets(text)[0]

    def test_json_escapes(self):
        text = '{"token":"' + esc(KEY) + '","n":1}'
        out = self.redact(text)
        self.assertRegex(out, r'\[REDACTED_GITHUB_TOKEN\]')
        self.assertNotIn(BS + 'u00', out)
        self.assertTrue(out.startswith('{"token":"') and out.endswith('","n":1}'))

    def test_json_escapes_without_secret_unchanged(self):
        text = '{"msg":"' + esc('hello world, nothing here') + '","q":"' + BS + 'u00e9' + BS + 'n"}'
        self.assertEqual(self.redact(text), text)

    def test_base64_run_replaced(self):
        out = self.redact('data: ' + b64('config: token ' + KEY + ' end') + ' done')
        self.assertEqual(out, 'data: [REDACTED_GITHUB_TOKEN] done')

    def test_base64_wrapped_at_76(self):
        enc = b64('AWS_ACCESS_KEY_ID=' + AWS + '\nregion=us-east-1\n' + 'x' * 40)
        wrapped = '\n'.join(enc[i:i + 76] for i in range(0, len(enc), 76))
        out = self.redact('-----\n' + wrapped + '\n-----')
        self.assertNotIn(enc[:20], out)
        self.assertRegex(out, r'\[REDACTED_AWS_KEY\]')
        self.assertTrue(out.endswith('\n-----'))

    def test_ordinary_base64_unchanged(self):
        image = base64.b64encode(os.urandom(300)).decode()
        text = 'img: ' + image + '\nsha: ' + 'a' * 64 + '\ntext: ' + b64('just a plain sentence about nothing')
        self.assertEqual(self.redact(text), text)

    def test_shell_expansion(self):
        out = self.redact('A=AKIA; echo "$A"IOSFODNN7EXAMPLE')
        self.assertNotIn('IOSFODNN7EXAMPLE', out)
        self.assertRegex(out, r'\[REDACTED_AWS_KEY\]')
        two = self.redact('A=ghp_a1B2c3D4e5F6g7H8; B=i9J0k1L2m3N4o5P6q7R8; echo ${A}$B')
        self.assertTrue(two.endswith('echo [REDACTED_GITHUB_TOKEN]'), two)
        self.assertRegex(two, r'\[REDACTED_GITHUB_TOKEN\]')

    def test_shell_without_secret_unchanged(self):
        text = 'DIR=/opt/app; NAME=build; echo "$DIR"/out "${NAME}"-1 $UNSET'
        self.assertEqual(self.redact(text), text)


if __name__ == '__main__':
    unittest.main()
