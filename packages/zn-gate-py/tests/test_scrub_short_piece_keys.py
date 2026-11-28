"""Slack and Discord webhook URLs cut into pieces of 8 to 17 characters (the host itself is split, and there is no digit
or capital letter to join the pieces by), and fixed-length keys (SendGrid, Linear, DigitalOcean, GitHub fine-grained
tokens, Azure storage keys, Telegram bot tokens) cut into three or more pieces with a plain line right after them: the
whole key is redacted and the line after it is left alone. Fictitious keys only, built from pieces. The Node.js twin is
packages/zn-gate/test/scrub_short_piece_keys.test.js."""
import re
import time
import unittest

from zn_gate import rules as R

ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
HEX = '0123456789abcdef'


def body(n: int, seed: int, alphabet: str = ALNUM) -> str:
    s = ''.join(alphabet[(i * 7 + seed * 11 + (i * i) % 13) % len(alphabet)] for i in range(n))
    return s[:4] + ('fade' if alphabet == HEX else 'FAKE') + s[8:]


AZURE = 'AccountKey=' + body(86, 9, ALNUM + '+/') + '=='
KEYS = {
    'slack': ('https://hooks.slack.com/services/T0000/B0000/' + body(24, 1), body(24, 1), '[REDACTED_SLACK_WEBHOOK]', 0),
    'discord': ('https://discord.com/api/webhooks/' + '0000' + '1234567890123456' + '/' + body(68, 2), body(68, 2),
                '[REDACTED_DISCORD_WEBHOOK]', 0),
    'sendgrid': ('SG.' + body(22, 3) + '.' + body(43, 4), body(43, 4), '[REDACTED_SENDGRID_KEY]', 0),
    'linear': ('lin_api_' + body(40, 5), body(40, 5), '[REDACTED_LINEAR_KEY]', 0),
    'digitalocean': ('doo_v1_' + body(64, 6, HEX), body(64, 6, HEX), '[REDACTED_DIGITALOCEAN_TOKEN]', 0),
    'github': ('github_pat_' + body(22, 7) + '_' + body(59, 8), body(59, 8), '[REDACTED_GITHUB_TOKEN]', 0),
    'azure': (AZURE, AZURE[11:-2], '[REDACTED_AZURE_STORAGE_KEY]', 11),
    'telegram': ('1234567890:AA' + body(33, 10), body(33, 10), '[REDACTED_TELEGRAM_BOT_TOKEN]', 11),
}
SEPARATORS = {
    'lf': '\n', 'crlf': '\r\n', 'indent': '\n    ', 'space_lf': ' \n', 'backslash': ' \\\n', 'nbsp': '\u00a0',
    'u2028': '\u2028', 'tab': '\t', 'dq_lf': '"\n"', 'sq_lf': "'\n'", 'dq_plus': '"+"', 'escaped': '\\n',
}
CONTEXTS = {
    'bare': lambda k: k,
    'dotenv': lambda k: 'DEBUG=1\nSERVICE_TOKEN=' + k + '\nREGION=eu-west-1\n',
    'shell': lambda k: 'export SERVICE_TOKEN=' + k + '\nrun-deploy --now\n',
    'yaml': lambda k: 'env:\n  SERVICE_TOKEN: ' + k + '\n  REGION: eu-west-1\n',
    'prose': lambda k: 'Please rotate this value now: ' + k + ' before Friday.',
    'markdown': lambda k: 'The token is `' + k + '` and it expires soon.\n',
}
WIDTHS = [8, 9, 10, 12, 13, 15, 17, 19, 22, 26]
_FLAT = re.compile(r'\\[nrt]|[\s"\'+\\`\u2028\u2029\u00a0\u200b\u200c\u200d\ufeff]')


def wrap(s: str, width: int, sep: str, keep: int = 0) -> str:
    return s[:keep] + sep.join(s[i:i + width] for i in range(keep, len(s), width))


def cut(family: str, width: int, sep: str) -> str:
    key, _secret, _marker, keep = KEYS[family]
    return wrap(key, width, sep, keep)


def readable(out: str, secret: str) -> str:
    flat = _FLAT.sub('', out)
    for i in range(0, len(secret) - 7):
        if secret[i:i + 8] in flat:
            return secret[i:i + 8]
    return ''


class ShortPieceKeysTests(unittest.TestCase):
    def test_rules_version(self):
        self.assertGreaterEqual(R.RULES_VERSION, '2026-11-27.12')

    def test_cut_keys_are_redacted_whole(self):
        for family, (_key, secret, _marker, _keep) in KEYS.items():
            for ctx_name, ctx in CONTEXTS.items():
                for sep_name, sep in SEPARATORS.items():
                    for width in WIDTHS:
                        out = R.redact_secrets(ctx(cut(family, width, sep)))[0]
                        left = readable(out, secret)
                        self.assertEqual(left, '', '%s %s %s %d: %r readable in %r' % (family, ctx_name, sep_name, width, left, out))

    def test_plain_line_after_a_fixed_length_key_is_left_alone(self):
        for family in ('sendgrid', 'linear', 'digitalocean', 'github', 'azure', 'telegram', 'slack'):
            for width in (12, 19, 24):
                out = R.redact_secrets('export SERVICE_TOKEN=' + cut(family, width, '\n') + '\nrun-deploy --now\n')[0]
                self.assertTrue(out.endswith('\nrun-deploy --now\n'), (family, width, out))
                self.assertIn(KEYS[family][2], out, (family, width, out))

    def test_azure_padding_alone_on_the_last_line(self):
        cut_key = AZURE[:11] + wrap(AZURE[11:-2], 29, '\r\n') + '\r\n='
        out = R.redact_secrets('env:\n  SERVICE_TOKEN: ' + cut_key + '\n  REGION: eu-west-1\n')[0]
        self.assertEqual(readable(out, AZURE[11:-2]), '')
        self.assertTrue(out.endswith('\n  REGION: eu-west-1\n'), out)

    def test_word_longer_than_what_the_discord_token_needs_is_left_alone(self):
        cut_key = wrap(KEYS['discord'][0][:-4], 14, '\n')
        out = R.redact_secrets(cut_key + '\nREGION-NAME-IS-LONG\n')[0]
        self.assertTrue(out.endswith('\nREGION-NAME-IS-LONG\n'), out)

    def test_keys_on_one_line_go_to_the_usual_rules(self):
        self.assertEqual(R.redact_secrets('x ' + KEYS['slack'][0] + ' y')[0], 'x [REDACTED_SLACK_WEBHOOK] y')
        self.assertEqual(R.redact_secrets('x ' + KEYS['discord'][0] + ' y')[0], 'x [REDACTED_DISCORD_WEBHOOK] y')
        self.assertEqual(R.redact_secrets('x ' + KEYS['sendgrid'][0] + ' y')[0], 'x [REDACTED_SENDGRID_KEY] y')

    def test_text_that_only_looks_like_the_start_of_a_cut_key_is_left_alone(self):
        texts = [
            'see https://hooks.slack.com/services/ in the docs\nand https://hooks.slack.com/services/T0000/B0000/ is the shape\n',
            'docs: https://discord.com/api/webhooks/\nthe id and the token follow\n',
            'The SG.\nprefix is used by SendGrid and lin_api_\nis the Linear prefix.\n',
            'call 1234567890:\nAAA is not a bot token, nor is 12345678:\nAAshort\n',
            'AccountKey=\nis a setting name, as is github_p\nat_is_not_a_token\n',
            'https://example.com/a\nhttps://example.com/b\nhttps://example.com/c\n',
        ]
        for t in texts:
            self.assertEqual(R.redact_secrets(t)[0], t)

    def test_cut_slack_url_of_another_shape_is_not_a_webhook(self):
        text = wrap('https://hooks.slack.com/services/T0000/C0000/' + body(24, 1), 12, '\n')
        self.assertNotIn('[REDACTED_SLACK_WEBHOOK]', R.redact_secrets(text)[0])

    def test_linear_time(self):
        def timed(t: str) -> float:
            s = time.perf_counter()
            R.redact_secrets(t)
            return (time.perf_counter() - s) * 1000
        units = [
            wrap(KEYS['slack'][0], 9, '\n') + '\n',
            wrap(KEYS['discord'][0], 14, '"\n"') + '\n',
            wrap(KEYS['sendgrid'][0], 21, ' \\\n') + '\nrun\n',
            'https://\n' * 40 + 'SG.\n' * 40 + '1234567890:\n' * 40 + 'AccountKey=\n' * 40,
            'https://d\n"+"iscord.com/api/webhooks/' + '1' * 18 + '/' + 'a\n' * 70,
        ]
        for unit in units:
            small, big = unit * 100, unit * 800
            timed(small)
            a = max(timed(small), 1.0)
            b = timed(big)
            self.assertLess(b, a * 8 * 6 + 400, '100 units %.1f ms, 800 units %.1f ms' % (a, b))

    def test_text_past_the_wrap_view_cap_is_not_read_for_cut_keys(self):
        big = wrap(KEYS['slack'][0], 9, '\n') + '\n' + 'x' * ((1 << 20) + 10)
        self.assertGreater(len(R.redact_secrets(big)[0]), 1 << 20)


if __name__ == '__main__':
    unittest.main()
