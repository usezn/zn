'use strict';
// Type-checks the guard declarations (lib/guard.d.ts, lib/client.d.ts) with the pinned TypeScript
// compiler, and checks that every declared guard export exists at runtime. Nothing is emitted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

test('guard.d.ts declares only exports that exist at runtime', () => {
  const guard = require('../lib/guard');
  const src = fs.readFileSync(path.join(root, 'lib', 'guard.d.ts'), 'utf8');
  const names = [...src.matchAll(/^export (?:function|class) (\w+)/gm)].map((m) => m[1]);
  assert.ok(names.length >= 3, 'expected the guard declarations');
  for (const n of names) assert.ok(n in guard, `lib/guard.js does not export ${n}`);
});

test('client.d.ts re-exports the guard API and the helpers it declares', () => {
  const client = require('../lib/client');
  const src = fs.readFileSync(path.join(root, 'lib', 'client.d.ts'), 'utf8');
  const fnNames = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  for (const n of ['checkToolCall', 'guardTool', 'GuardBlockError', 'sanitizeToolResult', 'redactSecrets',
    'logEvidence', 'verifyEvidenceLedger']) {
    assert.ok(n in client, `lib/client.js does not export ${n}`);
  }
  for (const n of fnNames) assert.ok(n in client, `lib/client.js does not export ${n}`);
});

test('GuardBlockError carries the documented code at runtime', () => {
  const { GuardBlockError } = require('../lib/guard');
  const err = new GuardBlockError({ allowed: false, verdict: 'block', rule: 'x', reason: 'y', confidence: 1 }, 't');
  assert.strictEqual(err.code, 'ZN_GUARD_BLOCK');
  assert.strictEqual(err.name, 'GuardBlockError');
});

test('tsc --noEmit accepts the guard usage example and rejects the marked misuse', () => {
  assert.ok(fs.existsSync(tsc), 'typescript is not installed: run npm ci');
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(__dirname, 'types', 'tsconfig.guard.json')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});
