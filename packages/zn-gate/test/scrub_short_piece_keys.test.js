'use strict';

// Slack and Discord webhook URLs cut into pieces of 8 to 17 characters (the host itself is split, and there is no
// digit or capital letter to join the pieces by), and fixed-length keys (SendGrid, Linear, DigitalOcean, GitHub
// fine-grained tokens, Azure storage keys, Telegram bot tokens) cut into three or more pieces with a plain line right
// after them: the whole key is redacted and the line after it is left alone. Fictitious keys only, built from pieces
// so that no complete key shape sits in this file. The Python twin is
// packages/zn-gate-py/tests/test_scrub_short_piece_keys.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, RULES_VERSION } = require('../lib/rules');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
function body(n, seed, alphabet = ALNUM) {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[(i * 7 + seed * 11 + (i * i) % 13) % alphabet.length];
  return s.slice(0, 4) + (alphabet === HEX ? 'fade' : 'FAKE') + s.slice(8);
}
const KEYS = {
  slack: { key: 'https://hooks.slack.com/services/T0000/B0000/' + body(24, 1), secret: body(24, 1), marker: '[REDACTED_SLACK_WEBHOOK]' },
  discord: {
    key: 'https://discord.com/api/webhooks/' + '0000' + '1234567890123456' + '/' + body(68, 2),
    secret: body(68, 2), marker: '[REDACTED_DISCORD_WEBHOOK]',
  },
  sendgrid: { key: 'SG.' + body(22, 3) + '.' + body(43, 4), secret: body(43, 4), marker: '[REDACTED_SENDGRID_KEY]' },
  linear: { key: 'lin_api_' + body(40, 5), secret: body(40, 5), marker: '[REDACTED_LINEAR_KEY]' },
  digitalocean: { key: 'doo_v1_' + body(64, 6, HEX), secret: body(64, 6, HEX), marker: '[REDACTED_DIGITALOCEAN_TOKEN]' },
  github: { key: 'github_pat_' + body(22, 7) + '_' + body(59, 8), secret: body(59, 8), marker: '[REDACTED_GITHUB_TOKEN]' },
  azure: { key: 'AccountKey=' + body(86, 9, ALNUM + '+/').replace(/[^A-Za-z0-9+/]/g, 'a') + '==', secret: null, keep: 11, marker: '[REDACTED_AZURE_STORAGE_KEY]' },
  telegram: { key: '1234567890:AA' + body(33, 10) , secret: body(33, 10), keep: 11, marker: '[REDACTED_TELEGRAM_BOT_TOKEN]' },
};
KEYS.azure.secret = KEYS.azure.key.slice(11, -2);

function wrap(s, width, sep, keep = 0) {
  const parts = [];
  for (let i = keep; i < s.length; i += width) parts.push(s.slice(i, i + width));
  return s.slice(0, keep) + parts.join(sep);
}
// A key as the fuzz cuts it: the label before the secret part (the Azure "AccountKey=", the digits and colon of a
// Telegram token) stays on the first line.
function cut(family, width, sep) { return wrap(KEYS[family].key, width, sep, KEYS[family].keep || 0); }
// The text with every separator the fuzz uses taken out, to look for what is still readable.
function flat(s) { return s.replace(/\\[nrt]|[\s"'+\\`\u2028\u2029\u00a0\u200b\u200c\u200d\ufeff]/g, ''); }
function readable(out, secret) {
  const f = flat(out);
  for (let i = 0; i + 8 <= secret.length; i++) if (f.includes(secret.slice(i, i + 8))) return secret.slice(i, i + 8);
  return '';
}

const SEPARATORS = {
  lf: '\n',
  crlf: '\r\n',
  indent: '\n    ',
  space_lf: ' \n',
  backslash: ' \\\n',
  nbsp: '\u00a0',
  u2028: '\u2028',
  tab: '\t',
  dq_lf: '"\n"',
  sq_lf: "'\n'",
  dq_plus: '"+"',
  escaped: '\\n',
};
const CONTEXTS = {
  bare: (k) => k,
  dotenv: (k) => 'DEBUG=1\nSERVICE_TOKEN=' + k + '\nREGION=eu-west-1\n',
  shell: (k) => 'export SERVICE_TOKEN=' + k + '\nrun-deploy --now\n',
  yaml: (k) => 'env:\n  SERVICE_TOKEN: ' + k + '\n  REGION: eu-west-1\n',
  prose: (k) => 'Please rotate this value now: ' + k + ' before Friday.',
  markdown: (k) => 'The token is `' + k + '` and it expires soon.\n',
};
const WIDTHS = [8, 9, 10, 12, 13, 15, 17, 19, 22, 26];

test('RULES_VERSION is bumped', () => {
  assert.ok(RULES_VERSION >= '2026-11-27.12', RULES_VERSION);
});

for (const [family, k] of Object.entries(KEYS)) {
  test(`${family}: a key cut into short pieces is redacted whole, whatever the break and the context`, () => {
    for (const [ctxName, ctx] of Object.entries(CONTEXTS)) {
      for (const [sepName, sep] of Object.entries(SEPARATORS)) {
        for (const width of WIDTHS) {
          const text = ctx(cut(family, width, sep));
          const out = redactSecrets(text).sanitized;
          const left = readable(out, k.secret);
          assert.equal(left, '', `${family} ${ctxName} ${sepName} ${width}: ${JSON.stringify(left)} readable in ${JSON.stringify(out)}`);
        }
      }
    }
  });
}

test('a fixed-length key followed by a plain line leaves that line alone', () => {
  for (const family of ['sendgrid', 'linear', 'digitalocean', 'github', 'azure', 'telegram', 'slack']) {
    for (const width of [12, 19, 24]) {
      const out = redactSecrets('export SERVICE_TOKEN=' + cut(family, width, '\n') + '\nrun-deploy --now\n').sanitized;
      assert.ok(out.endsWith('\nrun-deploy --now\n'), `${family} ${width}: ${JSON.stringify(out)}`);
      assert.ok(out.includes(KEYS[family].marker), `${family} ${width}: ${JSON.stringify(out)}`);
    }
  }
});

test('an Azure key whose padding sits alone on the last line is redacted whole', () => {
  const k = KEYS.azure.key;
  const cutKey = k.slice(0, 11) + wrap(k.slice(11, -2), 29, '\r\n') + '\r\n=';
  const out = redactSecrets('env:\n  SERVICE_TOKEN: ' + cutKey + '\n  REGION: eu-west-1\n').sanitized;
  assert.equal(readable(out, KEYS.azure.secret), '');
  assert.ok(out.endsWith('\n  REGION: eu-west-1\n'), out);
});

test('a Discord token followed by a word longer than what the token still needs leaves the word alone', () => {
  const cut = wrap(KEYS.discord.key.slice(0, -4), 14, '\n');
  const out = redactSecrets(cut + '\nREGION-NAME-IS-LONG\n').sanitized;
  assert.ok(out.endsWith('\nREGION-NAME-IS-LONG\n'), JSON.stringify(out));
});

test('a webhook URL or key on one line is left to the usual rules', () => {
  assert.equal(redactSecrets('x ' + KEYS.slack.key + ' y').sanitized, 'x [REDACTED_SLACK_WEBHOOK] y');
  assert.equal(redactSecrets('x ' + KEYS.discord.key + ' y').sanitized, 'x [REDACTED_DISCORD_WEBHOOK] y');
  assert.equal(redactSecrets('x ' + KEYS.sendgrid.key + ' y').sanitized, 'x [REDACTED_SENDGRID_KEY] y');
});

test('text that only looks like the start of a cut key is left alone', () => {
  const texts = [
    'see https://hooks.slack.com/services/ in the docs\nand https://hooks.slack.com/services/T0000/B0000/ is the shape\n',
    'docs: https://discord.com/api/webhooks/\nthe id and the token follow\n',
    'The SG.\nprefix is used by SendGrid and lin_api_\nis the Linear prefix.\n',
    'call 1234567890:\nAAA is not a bot token, nor is 12345678:\nAAshort\n',
    'AccountKey=\nis a setting name, as is github_p\nat_is_not_a_token\n',
    'https://example.com/a\nhttps://example.com/b\nhttps://example.com/c\n',
  ];
  for (const t of texts) assert.equal(redactSecrets(t).sanitized, t);
});

test('a cut Slack URL of another shape is not taken for a webhook', () => {
  const text = wrap('https://hooks.slack.com/services/T0000/C0000/' + body(24, 1), 12, '\n');
  assert.ok(!redactSecrets(text).sanitized.includes('[REDACTED_SLACK_WEBHOOK]'));
});

test('linear time on long texts of cut keys and of anchors that never match', () => {
  const time = (t) => { const s = process.hrtime.bigint(); redactSecrets(t); return Number(process.hrtime.bigint() - s) / 1e6; };
  const units = [
    wrap(KEYS.slack.key, 9, '\n') + '\n',
    wrap(KEYS.discord.key, 14, '"\n"') + '\n',
    wrap(KEYS.sendgrid.key, 21, ' \\\n') + '\nrun\n',
    'https://\n'.repeat(40) + 'SG.\n'.repeat(40) + '1234567890:\n'.repeat(40) + 'AccountKey=\n'.repeat(40),
    ('https://d\n"+"iscord.com/api/webhooks/' + '1'.repeat(18) + '/' + 'a\n'.repeat(70)),
  ];
  for (const unit of units) {
    const small = unit.repeat(100);
    const big = unit.repeat(800);
    time(small);
    const a = Math.max(time(small), 1);
    const b = time(big);
    assert.ok(b < a * 8 * 6 + 200, `100 units ${a} ms, 800 units ${b} ms`);
  }
});

test('a text past the wrap view cap is not read for cut keys', () => {
  const big = wrap(KEYS.slack.key, 9, '\n') + '\n' + 'x'.repeat((1 << 20) + 10);
  assert.ok(redactSecrets(big).sanitized.length > (1 << 20));
});
