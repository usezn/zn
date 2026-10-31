// Tests for prune-bundled-sources.js. Run: node --test .github/scripts/prune-bundled-sources.test.mjs
// The script runs when loaded and exports nothing, so every test runs it as a CLI on a fixture package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prune-bundled-sources.js');

const LOCK = {
  name: 'fixture',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture' },
    'node_modules/dep-a': { version: '1.0.0' },
    'node_modules/dep-a/node_modules/nested': { version: '2.0.0' },
    'node_modules/dev-tool': { version: '3.0.0', dev: true },
    'node_modules/not-on-disk': { version: '4.0.0' },
  },
};

// Files that must be removed, and files that must stay, in a bundled package tree.
const PRUNED = [
  'node_modules/dep-a/index.ts',
  'node_modules/dep-a/lib/util.mts',
  'node_modules/dep-a/lib/util.cts',
  'node_modules/dep-a/index.js.map',
  'node_modules/dep-a/node_modules/nested/src/n.ts', // nested package is listed in the lockfile
];
const KEPT = [
  'node_modules/dep-a/package.json',
  'node_modules/dep-a/index.js',
  'node_modules/dep-a/index.d.ts',
  'node_modules/dep-a/lib/types.d.mts',
  'node_modules/dep-a/lib/types.d.cts',
  'node_modules/dep-a/LICENSE',
  'node_modules/dep-a/node_modules/nested/src/n.js',
  'node_modules/dev-tool/src/d.ts', // dev dependency: not bundled, left alone
  'node_modules/dev-tool/d.js.map',
  'src/app.ts', // project source outside node_modules
  'app.js.map',
];

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeFixture(t, { lock = LOCK } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  for (const rel of [...PRUNED, ...KEPT]) write(root, rel, `// ${rel}\n`);
  return root;
}

function prune(root) {
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
}

const exists = (root, rel) => fs.existsSync(path.join(root, rel));

test('removes .ts, .mts, .cts and .map files from bundled packages, nested ones included', (t) => {
  const root = makeFixture(t);
  const result = prune(root);
  assert.equal(result.status, 0, result.stderr);
  for (const rel of PRUNED) assert.equal(exists(root, rel), false, `${rel} should be removed`);
});

test('keeps type declarations, javascript, licences and package.json', (t) => {
  const root = makeFixture(t);
  assert.equal(prune(root).status, 0);
  for (const rel of KEPT.filter((r) => r.startsWith('node_modules/dep-a') || r.startsWith('node_modules/dev'))) {
    assert.equal(exists(root, rel), true, `${rel} should stay`);
  }
});

test('leaves dev dependencies and project source outside node_modules untouched', (t) => {
  const root = makeFixture(t);
  assert.equal(prune(root).status, 0);
  for (const rel of ['node_modules/dev-tool/src/d.ts', 'node_modules/dev-tool/d.js.map', 'src/app.ts', 'app.js.map']) {
    assert.equal(exists(root, rel), true, `${rel} should stay`);
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), `// ${rel}\n`);
  }
});

test('reports exactly the removed files, their bytes and the bundled package count', (t) => {
  const root = makeFixture(t);
  const bytes = PRUNED.reduce((sum, rel) => sum + Buffer.byteLength(`// ${rel}\n`), 0);
  const result = prune(root);
  assert.equal(result.status, 0, result.stderr);
  // not-on-disk is listed in the lockfile but missing: it still counts as a bundled package.
  assert.equal(
    result.stdout,
    `pruned ${PRUNED.length} source and map files (${bytes} bytes) from 3 bundled packages\n`,
  );
});

test('a second run finds nothing left to remove', (t) => {
  const root = makeFixture(t);
  assert.equal(prune(root).status, 0);
  const again = prune(root);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^pruned 0 source and map files \(0 bytes\) from 3 bundled packages\n$/);
});

test('does not descend into a nested node_modules that the lockfile does not list', (t) => {
  const lock = JSON.parse(JSON.stringify(LOCK));
  delete lock.packages['node_modules/dep-a/node_modules/nested'];
  const root = makeFixture(t, { lock });
  write(root, 'node_modules/dep-a/node_modules/unlisted/x.ts', 'x\n');
  assert.equal(prune(root).status, 0);
  assert.equal(exists(root, 'node_modules/dep-a/node_modules/unlisted/x.ts'), true);
});

test('fails with an error and removes nothing when package-lock.json is missing', (t) => {
  const root = makeFixture(t);
  fs.rmSync(path.join(root, 'package-lock.json'));
  const result = prune(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package-lock\.json/);
  for (const rel of PRUNED) assert.equal(exists(root, rel), true, `${rel} must not be touched`);
});
