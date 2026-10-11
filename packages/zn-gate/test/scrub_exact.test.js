'use strict';
/** Exact-value layer: sources, filters, variants and Aho-Corasick. Fake values only. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./_harness');
const X = require('../lib/scrub/exact');
const { mulberry32 } = require('./fixtures/fake_secrets');

const rnd = mulberry32(9001);
const pick = (n) => { const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(rnd() * c.length)]; return s; };

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-exact-')); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

test('sensitive names', () => {
  for (const n of ['API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'DATABASE_URL', 'SENTRY_DSN', 'CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'PGPASSWORD', 'AUTH', 'NPM_AUTH_TOKEN']) {
    assert.ok(X.isSensitiveName(n), n);
  }
  for (const n of ['PWD', 'OLDPWD', 'SSH_AUTH_SOCK', 'PATH', 'HOME', 'KEYBOARD_LAYOUT', 'TOKEN_TTL', 'API_KEY_FILE', 'AUTH_ENABLED', 'SECRET_PATH', 'TOKENIZERS_PARALLELISM', 'AWS_REGION']) {
    assert.ok(!X.isSensitiveName(n), n);
  }
});

test('non-secret values are ignored even under sensitive names', () => {
  for (const v of ['true', 'production', '3600', 'https://auth.example.org/callback', '/home/user/.ssh/id_ed25519', 'auth.example.org', '${OTHER_VAR}', 'short']) {
    assert.ok(X.looksNonSecret(v), v);
  }
  assert.ok(!X.looksNonSecret(pick(32)));
});

test('environment: sensitive names only, URL contributes its password only', () => {
  const pw = pick(20);
  const key = pick(40);
  const env = { PATH: '/usr/bin', OPENAI_API_KEY: key, DATABASE_URL: 'postgres://app:' + pw + '@db.internal:5432/app', HOME: '/home/u', DEBUG_TOKEN_TTL: '3600' };
  const got = X.collectSources({ env, files: false });
  const byValue = Object.fromEntries(got.map((e) => [e.value, e]));
  assert.ok(byValue[key] && byValue[key].type === 'ENV_OPENAI_API_KEY');
  assert.ok(byValue[pw] && byValue[pw].type === 'DB_PASSWORD');
  assert.ok(!got.some((e) => e.value.includes('db.internal')), 'host must stay readable');
  assert.strictEqual(got.length, 2);
});

test('files: .env*, credential files and .znrules; examples are skipped', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  const v = { dot: pick(32), local: pick(30), example: pick(30), aws: pick(40), npm: 'npm_' + pick(36), netrc: pick(24), gh: 'gho_' + pick(36), zn: pick(20), dockerPw: pick(18) };
  write(path.join(cwd, '.env'), '# comment\nPORT=3000\nNODE_ENV=production\nSTRIPE_SECRET="' + v.dot + '"\n');
  write(path.join(cwd, '.env.local'), 'export SESSION_SIGNING=' + v.local + '\n');
  write(path.join(cwd, '.env.example'), 'API_TOKEN=' + v.example + '\n');
  write(path.join(cwd, '.znrules'), '# rules\nsecret: LEGACY_KEY=' + v.zn + '\npath: /etc\n');
  write(path.join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIA' + pick(16).toUpperCase() + '\naws_secret_access_key = ' + v.aws + '\n');
  write(path.join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=' + v.npm + '\n');
  write(path.join(home, '.netrc'), 'machine example.org login me password ' + v.netrc + '\n');
  write(path.join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: ' + v.gh + '\n    user: me\n');
  write(path.join(home, '.docker', 'config.json'), JSON.stringify({ auths: { 'registry.example.org': { auth: Buffer.from('me:' + v.dockerPw).toString('base64') } } }));
  const got = X.collectSources({ env: {}, cwd, home });
  const values = new Set(got.map((e) => e.value));
  for (const k of ['dot', 'local', 'aws', 'npm', 'netrc', 'gh', 'zn', 'dockerPw']) assert.ok(values.has(v[k]), 'missing ' + k);
  assert.ok(!values.has(v.example), '.env.example must be skipped');
  assert.ok(!values.has('production') && !values.has('3000'));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('variants: raw, base64 (padded, unpadded, url-safe), hex (both cases), url-encoded', () => {
  const value = 'p@ss/' + pick(12) + '+?';
  const vs = X.variants(value);
  assert.strictEqual(vs[0], value);
  const b = Buffer.from(value);
  for (const expect of [b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex'), b.toString('hex').toUpperCase(), encodeURIComponent(value)]) {
    assert.ok(vs.includes(expect), 'missing variant ' + expect);
  }
  assert.strictEqual(new Set(vs).size, vs.length);
});

test('matcher finds every variant and reports type and name', () => {
  const secret = pick(28);
  const m = X.buildMatcher([{ name: 'DEPLOY_KEY', type: 'ENV_DEPLOY_KEY', value: secret }]);
  for (const v of X.variants(secret)) {
    const text = 'prefix ' + v + ' suffix';
    const spans = m.find(text);
    assert.ok(spans.some((s) => text.slice(s.start, s.end) === v && s.type === 'ENV_DEPLOY_KEY' && s.name === 'DEPLOY_KEY' && s.source === 'exact'), v);
  }
});

test('Aho-Corasick agrees with a naive search (randomised)', () => {
  const r = mulberry32(77);
  const alphabet = 'abcab';
  for (let round = 0; round < 200; round++) {
    const needles = [];
    const n = 1 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      let s = '';
      const len = 1 + Math.floor(r() * (round % 2 ? 40 : 5));
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(r() * alphabet.length)];
      needles.push({ text: s, payload: i });
    }
    let text = '';
    for (let j = 0; j < 300; j++) text += alphabet[Math.floor(r() * alphabet.length)];
    const ac = new X.AhoCorasick(needles);
    const got = ac.find(text).map((h) => h.start + ':' + h.payload).sort();
    const want = [];
    needles.forEach((nd, i) => {
      for (let at = text.indexOf(nd.text); at >= 0; at = text.indexOf(nd.text, at + 1)) want.push(at + ':' + i);
    });
    assert.deepStrictEqual(got, want.sort(), 'round ' + round);
  }
});

test('long values (several KB) are matched exactly and cheaply', () => {
  const long = pick(5000);
  const m = X.buildMatcher([{ name: 'REGISTRY', type: 'DOCKER_AUTH', value: long }]);
  assert.strictEqual(m.find('x' + long + 'y').length, 1);
  assert.strictEqual(m.find('x' + long.slice(0, 4999) + 'y').length, 0);
});

test('values shorter than 8 characters are never searched', () => {
  const m = X.buildMatcher([{ name: 'A', type: 'ENV_A', value: 'abc1234' }]);
  assert.strictEqual(m.size, 0);
});

if (require.main === module) run('scrub exact values');
