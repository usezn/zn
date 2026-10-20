'use strict';
// Type-checks test/types/usage.ts against the hand-written .d.ts files with the pinned TypeScript compiler.
// The compiler only reads; nothing is emitted and no network is used.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

test('package.json points "types" at a file that exists and ships in the package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.types, 'lib/client.d.ts');
  assert.ok(fs.existsSync(path.join(root, pkg.types)));
  assert.ok(pkg.files.includes('lib/'), 'lib/ (with the .d.ts files) must be in "files"');
});

test('every lib/*.d.ts sits next to a .js file of the same name', () => {
  for (const f of fs.readdirSync(path.join(root, 'lib')).filter((n) => n.endsWith('.d.ts'))) {
    assert.ok(fs.existsSync(path.join(root, 'lib', f.replace(/\.d\.ts$/, '.js'))), f);
  }
});

test('the runtime exports the names the type definitions declare', () => {
  const client = require('../lib/client');
  for (const n of ['analyze', 'analyzeLocal', 'checkToolResult', 'evaluate', 'longInputMode', 'RULES_VERSION',
    'LONG_INPUT_MIN_CHARS', 'isCloudEnabled', 'usesStoredKey', 'usableApiKey', 'resolveEndpoint']) {
    assert.ok(n in client, n);
  }
  const rules = require('../lib/rules');
  for (const n of ['evaluate', 'redactSecrets', 'sanitizeToolResult', 'RULES_VERSION']) assert.ok(n in rules, n);
  const ev = require('../lib/evidence');
  for (const n of ['logEvidence', 'verifyEvidenceLedger', 'EVIDENCE_FILE']) assert.ok(n in ev, n);
});

test('tsc --noEmit accepts the usage example and rejects the marked misuse', () => {
  assert.ok(fs.existsSync(tsc), 'typescript is not installed: run npm ci');
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(__dirname, 'types', 'tsconfig.json')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});
