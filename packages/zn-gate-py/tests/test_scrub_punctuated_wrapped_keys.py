"""Keys that carry their own punctuation (Azure storage keys, SendGrid, JWT, Slack and Discord webhook URLs) printed
across several lines, or split by quotes or Unicode spaces, are redacted whole, also in a NAME=value assignment: the
provider format wins over the generic assignment rule when the joined text shows the whole key. Fictitious keys only,
built from pieces. The Node.js twin is packages/zn-gate/test/scrub_punctuated_wrapped_keys.test.js."""
import time
import unittest

from zn_gate import rules as R

ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'


def body(n: int, seed: int) -> str:
    s = ''.join(ALNUM[(i * 7 + seed * 11 + (i * i) % 13) % len(ALNUM)] for i in range(n))
    return s[:4] + 'FAKE' + s[8:]


KEYS = {
    'azure': 'AccountKey=' + body(86, 1) + '==',
    'sendgrid': 'SG.' + body(22, 2) + '.' + body(43, 3),
    'jwt': 'eyJ' + body(20, 4) + '.eyJ' + body(24, 5) + '.' + body(43, 6),
    'slack': 'https://hooks.slack.com/services/T0000/B0000/' + body(24, 7),
    'discord': 'https://discord.com/api/webhooks/' + '0000' + '1234567890123456' + '/' + body(68, 8),
}
SECRET_PART = {
    'azure': KEYS['azure'][11:-2],
    'sendgrid': KEYS['sendgrid'][3:],
    'jwt': KEYS['jwt'][3:],
    'slack': KEYS['slack'][44:],
    'discord': KEYS['discord'][33:],
}
SEPARATORS = {
    'lf': '\n', 'crlf': '\r\n', 'indent': '\n    ', 'backslash': ' \\\n', 'nbsp': ' ', 'tab': '\t',
    'quotes': '"\n"', 'escaped': '\\n',
}
CONTEXTS = {
    'bare': lambda k: k,
    'dotenv': lambda k: 'DEBUG=1\nSERVICE_TOKEN=' + k + '\nREGION=eu-west-1\n',
    'shell': lambda k: 'export SERVICE_TOKEN=' + k + '\nmake deploy\n',
    'yaml': lambda k: 'env:\n  SERVICE_TOKEN: ' + k + '\n  REGION: eu-west-1\n',
    'markdown': lambda k: 'The token is `' + k + '` and it expires soon.\n',
    'prose': lambda k: 'Please rotate this value now: ' + k + ' before Friday.',
}
# (family, contexts, separators, widths): the widths of a real terminal, with a last piece of 8 or more characters.
CASES = [
    ('azure', ['markdown', 'prose', 'dotenv', 'shell', 'yaml'], ['lf', 'crlf', 'nbsp', 'tab', 'quotes', 'backslash'], [29, 40]),
    ('sendgrid', ['bare', 'dotenv', 'shell', 'yaml', 'markdown'], ['lf', 'crlf', 'indent', 'nbsp', 'backslash'], [30, 40]),
    ('jwt', ['bare', 'dotenv', 'shell', 'yaml', 'prose'], ['lf', 'crlf', 'indent', 'tab', 'quotes'], [32, 40]),
    ('slack', ['bare', 'dotenv', 'shell', 'yaml', 'markdown', 'prose'], ['lf', 'indent', 'nbsp', 'quotes', 'escaped'], [24, 30]),
    ('discord', ['bare', 'dotenv', 'shell', 'yaml', 'markdown', 'prose'], ['lf', 'indent', 'nbsp', 'quotes', 'escaped'], [25, 32]),
]


def wrap(s: str, width: int, sep: str) -> str:
    return sep.join(s[i:i + width] for i in range(0, len(s), width))


class PunctuatedWrappedKeys(unittest.TestCase):
    def redact(self, text: str) -> str:
        return R.redact_secrets(text)[0]

    def test_rules_version(self):
        self.assertTrue(R.RULES_VERSION >= '2026-11-27.11' or R.RULES_VERSION > '2026-11-27', R.RULES_VERSION)

    def test_wrapped_keys_are_redacted_whole(self):
        for key, contexts, seps, widths in CASES:
            for ctx in contexts:
                for sep_name in seps:
                    for width in widths:
                        sep = SEPARATORS[sep_name]
                        with self.subTest(key=key, ctx=ctx, sep=sep_name, width=width):
                            out = self.redact(CONTEXTS[ctx](wrap(KEYS[key], width, sep)))
                            secret = SECRET_PART[key]
                            for i in range(0, len(secret) - 7, 4):
                                self.assertNotIn(secret[i:i + 8], out)
                            if ctx in ('dotenv', 'yaml'):
                                self.assertRegex(out, r'REGION[=:] ?eu-west-1')
                            if ctx == 'shell':
                                self.assertIn('make deploy', out)
                            if ctx == 'markdown':
                                self.assertIn('and it expires soon.', out)
                            if ctx == 'prose':
                                self.assertIn('before Friday.', out)

    def test_wrapped_provider_key_in_assignment_is_named_after_its_provider(self):
        sg = self.redact('SERVICE_TOKEN=' + wrap(KEYS['sendgrid'], 34, '\n') + '\nREGION=eu-west-1\n')
        self.assertEqual(sg, 'SERVICE_TOKEN=[REDACTED_SENDGRID_KEY]\nREGION=eu-west-1\n')
        jwt = self.redact('SERVICE_TOKEN=' + wrap(KEYS['jwt'], 32, '\n') + '\nREGION=eu-west-1\n')
        self.assertEqual(jwt, 'SERVICE_TOKEN=[REDACTED_JWT]\nREGION=eu-west-1\n')
        az = self.redact('Please rotate: ' + wrap(KEYS['azure'], 29, '\n') + ' before Friday.')
        self.assertEqual(az, 'Please rotate: AccountKey=[REDACTED_AZURE_STORAGE_KEY] before Friday.')

    def test_piece_that_ends_or_starts_with_the_dot_of_the_key_is_joined(self):
        sg = KEYS['sendgrid']
        dot = sg.index('.', 3)
        for cut in (sg[:dot + 1] + '\n' + sg[dot + 1:], sg[:dot] + '\n' + sg[dot:]):
            out = self.redact('SERVICE_TOKEN=' + cut + '\nREGION=eu-west-1\n')
            self.assertNotIn(sg[dot + 1:dot + 15], out)

    def test_single_line_key_keeps_the_label_of_the_assignment_rule(self):
        out = self.redact('SERVICE_TOKEN=' + KEYS['sendgrid'] + '\n')
        self.assertIn(out, ('SERVICE_TOKEN=[REDACTED_SECRET]\n', 'SERVICE_TOKEN=[REDACTED_SENDGRID_KEY]\n'))

    def test_lines_that_only_look_like_pieces_of_a_key_are_left_alone(self):
        texts = [
            'The build finished at version 2.14.7.\nNextStepsAreListedBelowInTheDocs and more\n',
            'config_value_with_long_name.\nAnotherSentenceStartsHere, it is plain prose.\n',
            'requests_oauthlib==1.3.1\nsome_long_package_name==2.0.0\n',
            'see https://example.com/docs/getting-started/install\nhttps://example.com/docs/getting-started/usage\n',
        ]
        for t in texts:
            self.assertEqual(self.redact(t), t)

    def test_pin_or_comparison_after_a_long_token_is_not_the_padding_of_a_key(self):
        text = 'API_TOKEN=Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z\nrequests_oauthlib==1.3.1\nSETTING_NAME:=abcdefghij\n'
        out = self.redact(text)
        self.assertIn('\nrequests_oauthlib==1.3.1\n', out)
        self.assertIn('\nSETTING_NAME:=abcdefghij\n', out)

    def test_linear_time_on_long_texts_of_wrapped_keys_with_dots(self):
        unit = wrap(KEYS['sendgrid'], 24, '\n') + '\n'

        def timed(t):
            start = time.perf_counter()
            self.redact(t)
            return (time.perf_counter() - start) * 1000

        timed(unit * 50)
        a = max(timed(unit * 200), 1)
        b = timed(unit * 1600)
        self.assertLess(b, a * 8 * 6 + 400, '200 keys %.0f ms, 1600 keys %.0f ms' % (a, b))


if __name__ == '__main__':
    unittest.main()
