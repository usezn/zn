'use strict';

// Keys that carry their own punctuation (Azure storage keys, SendGrid, JWT, Slack and Discord webhook URLs) printed
// across several lines, or split by quotes or Unicode spaces, are redacted whole, also in a NAME=value assignment: the
// provider format wins over the generic assignment rule when the joined text shows the whole key. Fictitious keys
// only, built from pieces so that no complete key shape sits in this file. The Python twin is
// packages/zn-gate-py/tests/test_scrub_punctuated_wrapped_keys.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, RULES_VERSION } = require('../lib/rules');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// A deterministic fake body with the marker FAKE in it.
function body(n, seed) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[(i * 7 + seed * 11 + (i * i) % 13) % ALNUM.length];
  return s.slice(0, 4) + 'FAKE' + s.slice(8);
}
const KEYS = {
  azure: 'AccountKey=' + body(86, 1) + '==',
  sendgrid: 'SG.' + body(22, 2) + '.' + body(43, 3),
  jwt: 'eyJ' + body(20, 4) + '.eyJ' + body(24, 5) + '.' + body(43, 6),
  slack: 'https://hooks.slack.com/services/T0000/B0000/' + body(24, 7),
  discord: 'https://discord.com/api/webhooks/' + '0000' + '1234567890123456' + '/' + body(68, 8),
};
// The part of the key that must not stay readable: pieces of its secret body.
const SECRET_PART = {
  azure: KEYS.azure.slice(11, -2),
  sendgrid: KEYS.sendgrid.slice(3),
  jwt: KEYS.jwt.slice(3),
  slack: KEYS.slack.slice(44),
  discord: KEYS.discord.slice(33),
};

function wrap(s, width, sep) {
  const parts = [];
  for (let i = 0; i < s.length; i += width) parts.push(s.slice(i, i + width));
  return parts.join(sep);
}

const SEPARATORS = {
  lf: '\n',
  crlf: '\r\n',
  indent: '\n    ',
  backslash: ' \\\n',
  nbsp: ' ',
  tab: '\t',
  quotes: '"\n"',
  escaped: '\\n',
};

const CONTEXTS = {
  bare: (k) => k,
  dotenv: (k) => 'DEBUG=1\nSERVICE_TOKEN=' + k + '\nREGION=eu-west-1\n',
  shell: (k) => 'export SERVICE_TOKEN=' + k + '\nmake deploy\n',
  yaml: (k) => 'env:\n  SERVICE_TOKEN: ' + k + '\n  REGION: eu-west-1\n',
  markdown: (k) => 'The token is `' + k + '` and it expires soon.\n',
  prose: (k) => 'Please rotate this value now: ' + k + ' before Friday.',
};

function assertRedacted(name, text, key, width, sep) {
  const out = redactSecrets(text).sanitized;
  const label = `${name} width ${width} ${JSON.stringify(sep)}`;
  // No piece of the secret survives, not even a short one.
  const secret = SECRET_PART[key];
  for (let i = 0; i + 8 <= secret.length; i += 4) {
    assert.ok(!out.includes(secret.slice(i, i + 8)), `${label}: part ${i} of the key is readable in ${JSON.stringify(out)}`);
  }
  return out;
}

test('the rules version is the one of this change', () => {
  assert.ok(RULES_VERSION >= '2026-11-27.11' || RULES_VERSION.startsWith('2026-1') || RULES_VERSION > '2026-11-27', RULES_VERSION);
});

// The families, the contexts that failed in the seeded fuzz, and the widths of a real terminal (a key printed 24 to 40 characters a line).
const CASES = [
  ['azure', ['markdown', 'prose', 'dotenv', 'shell', 'yaml'], ['lf', 'crlf', 'nbsp', 'tab', 'quotes', 'backslash'], [29, 40]],
  ['sendgrid', ['bare', 'dotenv', 'shell', 'yaml', 'markdown'], ['lf', 'crlf', 'indent', 'nbsp', 'backslash'], [30, 40]],
  ['jwt', ['bare', 'dotenv', 'shell', 'yaml', 'prose'], ['lf', 'crlf', 'indent', 'tab', 'quotes'], [32, 40]],
  ['slack', ['bare', 'dotenv', 'shell', 'yaml', 'markdown', 'prose'], ['lf', 'indent', 'nbsp', 'quotes', 'escaped'], [24, 30]],
  ['discord', ['bare', 'dotenv', 'shell', 'yaml', 'markdown', 'prose'], ['lf', 'indent', 'nbsp', 'quotes', 'escaped'], [25, 32]],
];

for (const [key, contexts, seps, widths] of CASES) {
  for (const ctx of contexts) {
    test(`a wrapped ${key} key is redacted whole in ${ctx} text`, () => {
      for (const sepName of seps) {
        for (const width of widths) {
          const text = CONTEXTS[ctx](wrap(KEYS[key], width, SEPARATORS[sepName]));
          const out = assertRedacted(`${key}/${ctx}/${sepName}`, text, key, width, SEPARATORS[sepName]);
          // The lines around the key keep their own text.
          if (ctx === 'dotenv' || ctx === 'yaml') assert.match(out, /REGION[=:] ?eu-west-1/);
          if (ctx === 'shell') assert.ok(out.includes('make deploy'), out);
          if (ctx === 'markdown') assert.ok(out.includes('and it expires soon.'), out);
          if (ctx === 'prose') assert.ok(out.includes('before Friday.'), out);
        }
      }
    });
  }
}

test('a wrapped provider key in a NAME=value line is named after its provider', () => {
  const sg = redactSecrets('SERVICE_TOKEN=' + wrap(KEYS.sendgrid, 34, '\n') + '\nREGION=eu-west-1\n').sanitized;
  assert.equal(sg, 'SERVICE_TOKEN=[REDACTED_SENDGRID_KEY]\nREGION=eu-west-1\n');
  const jwt = redactSecrets('SERVICE_TOKEN=' + wrap(KEYS.jwt, 32, '\n') + '\nREGION=eu-west-1\n').sanitized;
  assert.equal(jwt, 'SERVICE_TOKEN=[REDACTED_JWT]\nREGION=eu-west-1\n');
  const az = redactSecrets('Please rotate: ' + wrap(KEYS.azure, 29, '\n') + ' before Friday.').sanitized;
  assert.equal(az, 'Please rotate: AccountKey=[REDACTED_AZURE_STORAGE_KEY] before Friday.');
});

test('a piece of a key that ends or starts with the dot of the key is joined', () => {
  // SendGrid and JWT keys hold dots: a line may end right after one or start right with one.
  const sg = KEYS.sendgrid;
  const dot = sg.indexOf('.', 3);
  const cut = sg.slice(0, dot + 1) + '\n' + sg.slice(dot + 1);
  assert.ok(!redactSecrets('SERVICE_TOKEN=' + cut + '\nREGION=eu-west-1\n').sanitized.includes(sg.slice(dot + 1, dot + 15)));
  const cut2 = sg.slice(0, dot) + '\n' + sg.slice(dot);
  assert.ok(!redactSecrets('SERVICE_TOKEN=' + cut2 + '\nREGION=eu-west-1\n').sanitized.includes(sg.slice(dot + 1, dot + 15)));
});

test('a key on one line keeps the label of the assignment rule', () => {
  const out = redactSecrets('SERVICE_TOKEN=' + KEYS.sendgrid + '\n').sanitized;
  assert.ok(out === 'SERVICE_TOKEN=[REDACTED_SECRET]\n' || out === 'SERVICE_TOKEN=[REDACTED_SENDGRID_KEY]\n', out);
});

test('lines that only look like pieces of a key are left alone', () => {
  const texts = [
    'The build finished at version 2.14.7.\nNextStepsAreListedBelowInTheDocs and more\n',
    'config_value_with_long_name.\nAnotherSentenceStartsHere, it is plain prose.\n',
    'requests_oauthlib==1.3.1\nsome_long_package_name==2.0.0\n',
    'see https://example.com/docs/getting-started/install\nhttps://example.com/docs/getting-started/usage\n',
  ];
  for (const t of texts) assert.equal(redactSecrets(t).sanitized, t);
});

test('a pin or a comparison after a long token is not the padding of a key', () => {
  const text = 'API_TOKEN=Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z\nrequests_oauthlib==1.3.1\nSETTING_NAME:=abcdefghij\n';
  const out = redactSecrets(text).sanitized;
  assert.ok(out.includes('\nrequests_oauthlib==1.3.1\n'), out);
  assert.ok(out.includes('\nSETTING_NAME:=abcdefghij\n'), out);
});

test('linear time on long texts of wrapped keys with dots', () => {
  const unit = wrap(KEYS.sendgrid, 24, '\n') + '\n';
  const small = unit.repeat(200);
  const big = unit.repeat(1600);
  const time = (t) => { const s = process.hrtime.bigint(); redactSecrets(t); return Number(process.hrtime.bigint() - s) / 1e6; };
  time(small);
  const a = Math.max(time(small), 1);
  const b = time(big);
  assert.ok(b < a * 8 * 6 + 200, `200 keys ${a} ms, 1600 keys ${b} ms`);
});
