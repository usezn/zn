'use strict';
/**
 * Seeded generator of the redaction differential corpus.
 *
 * test/fixtures/scrub_differential_corpus.json holds generated texts together with the text that
 * redactSecrets and redactScanSecrets (lib/rules.js) return for each. The Python package reads the
 * same file (tests/test_scrub_differential.py) and must return the same text from redact_secrets
 * and redact_scan_secrets, so the two engines stay exact twins on texts with fake keys that are
 * assigned, JSON-escaped, put in a URL query or a header, split by empty quote pairs, written with
 * percent-encoding or broken by an invisible character.
 *
 * Everything here is fabricated: values come from a seeded PRNG (mulberry32) and only reuse public
 * format prefixes; hosts are example.com.
 *
 *   node test/helpers/scrub_corpus.js --write    regenerate test/fixtures/scrub_differential_corpus.json
 *   node test/helpers/scrub_corpus.js --check    exit 1 if the file differs from what the generator makes
 */

const fs = require('node:fs');
const path = require('node:path');

const SEED = 20261103;
const COUNT = 2200;
const FILE = path.join(__dirname, '..', 'fixtures', 'scrub_differential_corpus.json');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B64 = ALNUM + '+/';
const B64URL = ALNUM + '-_';
const DIGITS = '0123456789';

function pick(rnd, chars, n) {
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(rnd() * chars.length)];
  return out;
}
const int = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const choose = (rnd, list) => list[Math.floor(rnd() * list.length)];

// Fake values, in pieces so that no whole key sits in this file.
const VALUES = [
  (r) => 'AKIA' + pick(r, UPPER32, 16),
  (r) => 'ghp_' + pick(r, ALNUM, 36),
  (r) => 'sk-ant-api03-' + pick(r, B64URL, 40),
  (r) => 'xoxb-' + pick(r, DIGITS, 12) + '-' + pick(r, DIGITS, 13) + '-' + pick(r, ALNUM, 24),
  (r) => 'AIza' + pick(r, B64URL, 35),
  (r) => 'npm_' + pick(r, ALNUM, 36),
  (r) => 'sk_' + 'live_' + pick(r, ALNUM, 24),
  (r) => 'glpat-' + pick(r, B64URL, 20),
  (r) => pick(r, B64, 40),
  (r) => pick(r, ALNUM, int(r, 16, 32)),
  (r) => 'fake' + pick(r, ALNUM, int(r, 8, 20)),
  (r) => choose(r, ['your-api-key-here', 'changeme', '${API_KEY}', 'example-value', 'short']),
];
const KEYS = ['api_key', 'token', 'password', 'secret', 'auth_token', 'AWS_SECRET_ACCESS_KEY', 'next_page_token',
  'log_level', 'client_secret', 'access_key', 'DB_PASSWORD', 'user'];
const SEPARATORS = ['=', ': ', ' = ', ':'];

function wordChar(c) {
  return /[A-Za-z0-9_+/.-]/.test(c);
}

// Empty quote pairs between word characters, %XX for some letters or digits, an invisible character.
function mutate(r, s) {
  const kind = r();
  let out = s;
  if (kind < 0.25) return out;
  if (kind < 0.5 || (kind >= 0.85 && kind < 0.95)) {
    const n = int(r, 1, 3);
    for (let k = 0; k < n; k++) {
      const spots = [];
      for (let i = 1; i < out.length; i++) if (wordChar(out[i - 1]) && wordChar(out[i])) spots.push(i);
      if (spots.length === 0) break;
      const at = choose(r, spots);
      const pair = choose(r, ['""', "''", '""""', "''''"]);
      out = out.slice(0, at) + pair + out.slice(at);
    }
  }
  if ((kind >= 0.5 && kind < 0.75) || kind >= 0.85 && kind < 0.95) {
    const n = int(r, 1, 3);
    for (let k = 0; k < n; k++) {
      const spots = [];
      for (let i = 0; i < out.length; i++) if (/[A-Za-z0-9]/.test(out[i]) && (i === 0 || out[i - 1] !== '%')) spots.push(i);
      if (spots.length === 0) break;
      const at = choose(r, spots);
      let hex = out.charCodeAt(at).toString(16).toUpperCase();
      if (r() < 0.5) hex = hex.toLowerCase();
      out = out.slice(0, at) + '%' + hex + out.slice(at + 1);
    }
  }
  if (kind >= 0.75 && kind < 0.85 || kind >= 0.95) {
    const at = int(r, 1, Math.max(1, out.length - 1));
    out = out.slice(0, at) + choose(r, ['​', '⁠', '­']) + out.slice(at);
  }
  return out;
}

function template(r, v, key) {
  const sep = choose(r, SEPARATORS);
  const sepEnc = r() < 0.1 ? choose(r, ['%3D', '%3d', '%3A']) : null;
  const k = key;
  switch (int(r, 0, 13)) {
    case 0: return 'echo ' + v;
    case 1: return k + (sepEnc || sep.trim() || '=') + v;
    case 2: return 'export ' + k + '=' + v;
    case 3: return 'export ' + k + '="' + v + '"';
    case 4: return k + sep + '"' + v + '"';
    case 5: return k + (sep.trim() === ':' ? ': ' : '=') + "'" + v + "'";
    case 6: return '{"cmd":"export ' + k + '=\\"' + v + '\\""}';
    case 7: return '{"cmd": "' + k + '=\\"' + v + '\\" node app.js"}';
    case 8: return 'https://example.com/p?x=1&' + k + (sepEnc || '=') + v;
    case 9: return 'GET /v1/items?' + k + '=' + v + ' HTTP/1.1';
    case 10: return 'curl -H "Authorization: Bearer ' + v + '" https://example.com/api';
    case 11: return '{"' + k + '": "' + v + '"}';
    case 12: return choose(r, ['the aws secret is ', 'aws secret access key: ', 'SecretAccessKey ', 'secret for aws = ']) + v;
    default: return 'run ' + v + ' now';
  }
}

function generate(count, seed) {
  const r = mulberry32(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = mutate(r, choose(r, VALUES)(r));
    out.push(template(r, v, choose(r, KEYS)));
  }
  return out;
}

// The corpus stores every string base64-encoded (UTF-8): the fake keys are built when the tests run, so no
// key-shaped text sits in the repository for secret scanners to report.
const encode = (s) => (s === null ? null : Buffer.from(s, 'utf8').toString('base64'));
const decode = (s) => (s === null ? null : Buffer.from(s, 'base64').toString('utf8'));
const decodeCases = (cases) => cases.map((c) => c.map(decode));

function build() {
  const rules = require('../../lib/rules');
  const inputs = generate(COUNT, SEED);
  const cases = inputs.map((input) => {
    const a = rules.redactSecrets(input).sanitized;
    const b = rules.redactScanSecrets(input).sanitized;
    return [input, a === input ? null : a, b === a ? null : b].map(encode);
  });
  const lines = cases.map((c) => '    ' + JSON.stringify(c));
  return '{\n  "comment": "Texts with fake keys and what redactSecrets and redactScanSecrets return for each; ' +
    'the Python redact_secrets and redact_scan_secrets must return the same. Each case is [input, redactSecrets ' +
    'output (null when equal to the input), redactScanSecrets output (null when equal to the redactSecrets output)], each string ' +
    'base64-encoded (UTF-8) so the file holds no key-shaped text; the tests decode it. Generated by test/helpers/scrub_corpus.js.",\n' +
    '  "seed": ' + SEED + ',\n  "count": ' + COUNT + ',\n  "cases": [\n' + lines.join(',\n') + '\n  ]\n}\n';
}

if (require.main === module) {
  const text = build();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(FILE, text);
    console.log('wrote ' + FILE + ' (' + text.length + ' bytes)');
  } else if (process.argv.includes('--check')) {
    const same = fs.readFileSync(FILE, 'utf8') === text;
    console.log(same ? 'corpus is current' : 'corpus differs from the generator');
    process.exit(same ? 0 : 1);
  } else {
    console.error('usage: node scrub_corpus.js --write|--check');
    process.exit(2);
  }
}

module.exports = { generate, decodeCases, SEED, COUNT, FILE, mulberry32 };
