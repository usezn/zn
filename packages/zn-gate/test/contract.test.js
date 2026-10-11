'use strict';
/**
 * Interface contract for the scrubber, the vault and the broker.
 *
 * Checks that every module exists and exposes the agreed surface. Modules
 * that are still placeholders must fail with code ZN_NOT_IMPLEMENTED; once a
 * module is implemented, the shape of its results is checked as well.
 */
const assert = require('assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const NOT_IMPLEMENTED = 'ZN_NOT_IMPLEMENTED';
const TOKEN_RE = /^__ZN_[A-Z0-9](?:[A-Z0-9_]*[A-Z0-9])?__$/;
const SOURCES = ['exact', 'pattern', 'pii'];

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push((async () => {
    try {
      await fn();
      passed++;
      console.log('  ok   ' + name);
    } catch (err) {
      failed++;
      console.log('  FAIL ' + name + '\n       ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : err));
    }
  })());
}

function load(rel) {
  return require(path.join(LIB, rel));
}

function assertFunctions(mod, spec, label) {
  for (const [name, arity] of Object.entries(spec)) {
    assert.strictEqual(typeof mod[name], 'function', label + '.' + name + ' must be a function');
    assert.strictEqual(mod[name].length, arity, label + '.' + name + ' must declare ' + arity + ' parameter(s)');
  }
}

function isNotImplemented(err) {
  return !!err && err.code === NOT_IMPLEMENTED;
}

/* A call that must return a Promise (async by contract). Resolves to
 * {value} or {error}; a synchronous throw is a contract violation. */
async function callAsync(fn, args) {
  const out = fn(...args);
  assert.ok(out && typeof out.then === 'function', 'must return a Promise');
  try {
    return { value: await out };
  } catch (error) {
    return { error };
  }
}

function memoryVault() {
  const byKey = new Map();
  const byToken = new Map();
  const counters = new Map();
  return {
    mapToken(project, type, value) {
      const key = project + '\0' + type + '\0' + value;
      if (!byKey.has(key)) {
        const n = (counters.get(project + '\0' + type) || 0) + 1;
        counters.set(project + '\0' + type, n);
        const token = '__ZN_' + type + '_' + n + '__';
        byKey.set(key, token);
        byToken.set(project + '\0' + token, value);
      }
      return byKey.get(key);
    },
    resolve(project, token) { return byToken.has(project + '\0' + token) ? byToken.get(project + '\0' + token) : null; },
    setSecret() {}, listSecrets() { return []; }, removeSecret() {},
    exactValues() { return []; }, audit() {},
  };
}

const ctx = (extra) => Object.assign({ project: 'contract-test', agent: 'test', tool: 'read', destination: 'assistant', vault: memoryVault() }, extra || {});

console.log('contract tests');

test('every module of the contract exists and loads', () => {
  for (const rel of [
    'scrub/engine.js', 'scrub/patterns.js', 'scrub/exact.js',
    'vault/store.js', 'vault/keychain.js', 'vault/daemon.js', 'vault/client.js', 'vault/audit.js',
    'broker/run.js', 'broker/mcp.js', 'hooks/runner.js', 'agents/claude-code.js',
  ]) {
    assert.ok(load(rel), rel + ' must export something');
  }
});

test('scrub/engine exposes scan, tokenize, detokenize', () => {
  assertFunctions(load('scrub/engine.js'), { scan: 2, tokenize: 2, detokenize: 2 }, 'engine');
});

test('scrub/engine.scan is synchronous and returns Span[]', () => {
  const { scan } = load('scrub/engine.js');
  let spans;
  try {
    spans = scan('nothing sensitive here', ctx());
  } catch (err) {
    if (isNotImplemented(err)) return;
    throw err;
  }
  assert.ok(Array.isArray(spans), 'scan must return an array (not a Promise)');
  for (const s of spans) {
    assert.ok(Number.isInteger(s.start) && Number.isInteger(s.end) && s.start < s.end);
    assert.strictEqual(typeof s.type, 'string');
    assert.ok(SOURCES.includes(s.source));
  }
});

test('scrub/engine.tokenize is async and returns {text, replaced[{type, token, source}]}', async () => {
  const { tokenize } = load('scrub/engine.js');
  const sample = 'export SERVICE_PASSWORD_URL=postgres://app:' + 'Zq8vT3kLm2Rx9wPa' + '@db.internal:5432/app\n';
  const r = await callAsync(tokenize, [sample, ctx()]);
  if (r.error) { if (isNotImplemented(r.error)) return; throw r.error; }
  assert.strictEqual(typeof r.value.text, 'string');
  assert.ok(Array.isArray(r.value.replaced));
  assert.ok(r.value.replaced.length >= 1, 'a connection-string password must be replaced');
  for (const item of r.value.replaced) {
    assert.strictEqual(typeof item.type, 'string');
    assert.ok(TOKEN_RE.test(item.token), 'token format: ' + item.token);
    assert.ok(SOURCES.includes(item.source), 'source: ' + item.source);
  }
});

test('scrub/engine.detokenize is async and returns {text, restored[], withheld[{token, reason}]}', async () => {
  const { detokenize } = load('scrub/engine.js');
  const r = await callAsync(detokenize, ['echo __ZN_EMAIL_1__', ctx({ destination: 'bash_local' })]);
  if (r.error) { if (isNotImplemented(r.error)) return; throw r.error; }
  assert.strictEqual(typeof r.value.text, 'string');
  assert.ok(Array.isArray(r.value.restored));
  assert.ok(Array.isArray(r.value.withheld));
  for (const w of r.value.withheld) {
    assert.ok(TOKEN_RE.test(w.token));
    assert.strictEqual(typeof w.reason, 'string');
  }
});

test('vault/client exposes the seven async calls', async () => {
  const client = load('vault/client.js');
  assertFunctions(client, {
    mapToken: 3, resolve: 2, setSecret: 3, listSecrets: 0, removeSecret: 1, exactValues: 1, audit: 1,
  }, 'vault/client');
});

test('agents/claude-code follows the adapter shape', () => {
  const a = load('agents/claude-code.js');
  assert.strictEqual(a.id, 'claude-code');
  // install/uninstall/detect may declare defaulted options (arity 0).
  for (const fn of ['detect', 'install', 'uninstall']) assert.strictEqual(typeof a[fn], 'function', fn);
  assertFunctions(a, { normalize: 1, respond: 1 }, 'agents/claude-code');
});

test('broker and hooks expose their entry points', () => {
  assert.strictEqual(typeof load('broker/run.js').main, 'function');
  assert.strictEqual(typeof load('broker/mcp.js').startSecretsMcp, 'function');
  assert.strictEqual(typeof load('hooks/runner.js').handle, 'function');
});

test('vault client exposes the approval and metadata calls', () => {
  assertFunctions(load('vault/client.js'), { updateSecretMeta: 2, isApproved: 3, recordApproval: 3 }, 'vault/client');
  assert.strictEqual(typeof load('vault/audit.js').read, 'function');
});

Promise.all(pending).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed > 0 ? 1 : 0;
});
