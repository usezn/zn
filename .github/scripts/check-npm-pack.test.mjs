// Tests for check-npm-pack.js: the file list of the zn-gate npm tarball.
// Each test writes a package directory (package.json, package-lock.json,
// THIRD_PARTY_NOTICES.md) and a `npm pack --json` output into a temp dir, then runs the
// real CLI. No network, no npm.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'check-npm-pack.js');

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'check-npm-pack-'));
  dirs.push(d);
  return d;
}

const OWN = [
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'dist/index.js',
  'dist/index.d.ts',
  'bin/cli.js',
];
const BUNDLED = ['node_modules/left-pad/package.json', 'node_modules/left-pad/LICENSE', 'node_modules/left-pad/index.js'];
const GOOD_NOTICES = [
  '# Third party notices',
  '',
  '| Package | Version | License | Source |',
  '|---|---|---|---|',
  '| left-pad | 1.3.0 | MIT | https://example.invalid/left-pad |',
  '',
].join('\n');

// A package directory. `pkg` is merged over a valid package.json; `lock` replaces the
// package-lock.json object; `notices` replaces THIRD_PARTY_NOTICES.md.
function packageDir({ pkg = {}, lock, notices = GOOD_NOTICES } = {}) {
  const dir = tempDir();
  const manifest = {
    name: 'zn-gate',
    version: '9.9.9',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    bin: { 'zn-gate': './bin/cli.js' },
    ...pkg,
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  const defaultLock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'zn-gate', version: '9.9.9' },
      'node_modules/left-pad': { version: '1.3.0', license: 'MIT' },
      'node_modules/jest': { version: '29.0.0', dev: true },
    },
  };
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock ?? defaultLock));
  writeFileSync(join(dir, 'THIRD_PARTY_NOTICES.md'), notices);
  return dir;
}

// The output of `npm pack --json`: npm prints lifecycle lines before the array.
function packJson({ files = [...OWN, ...BUNDLED], unpackedSize = 12345, raw } = {}) {
  const path = join(tempDir(), 'pack.json');
  const body =
    raw ??
    'npm notice prepack zn-gate\n' +
      JSON.stringify([
        { name: 'zn-gate', version: '9.9.9', unpackedSize, files: files.map((p) => ({ path: p })) },
      ]);
  writeFileSync(path, body);
  return path;
}

function run(packPath, dir) {
  return spawnSync(process.execPath, [SCRIPT, packPath, dir], { encoding: 'utf8' });
}

test('a complete tarball passes and the summary counts own and bundled files', () => {
  const r = run(packJson(), packageDir());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    r.stdout.includes('zn-gate@9.9.9: 10 files (7 own, 3 bundled), 12345 bytes unpacked, 1 bundled packages'),
    r.stdout,
  );
  assert.ok(r.stdout.includes('npm package contents OK'));
});

test('the summary reports the unpacked size from npm (no limit is enforced)', () => {
  const r = run(packJson({ unpackedSize: 987654 }), packageDir());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /987654 bytes unpacked/);
});

test('Windows path separators in the pack output are read as forward slashes', () => {
  const files = ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist\\index.js', 'dist\\index.d.ts', 'bin\\cli.js', ...BUNDLED];
  const r = run(packJson({ files }), packageDir());
  assert.equal(r.status, 0, r.stderr);
});

for (const missing of ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/index.js', 'dist/index.d.ts', 'bin/cli.js']) {
  test(`a missing required file fails the check: ${missing}`, () => {
    const r = run(packJson({ files: [...OWN, ...BUNDLED].filter((f) => f !== missing) }), packageDir());
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`error: missing required file: ${missing}`), r.stderr);
  });
}

test('a second bin target missing from the tarball is reported', () => {
  const dir = packageDir({ pkg: { bin: { 'zn-gate': './bin/cli.js', 'zn-gate-lint': './bin/lint.js' } } });
  const r = run(packJson(), dir);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error: missing required file: bin/lint.js'), r.stderr);
});

test('a package.json without "types" fails the check', () => {
  const dir = packageDir({ pkg: { types: undefined } });
  const r = run(packJson(), dir);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error: package.json has no "types" field'), r.stderr);
});

test('a bundled dependency from the lockfile that is missing from the tarball fails', () => {
  const r = run(packJson({ files: OWN }), packageDir());
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error: bundled dependency not in tarball: node_modules/left-pad'), r.stderr);
});

test('a bundled dependency shipped without a LICENSE file fails', () => {
  const files = [...OWN, 'node_modules/left-pad/package.json', 'node_modules/left-pad/index.js'];
  const r = run(packJson({ files }), packageDir());
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('bundled dependency ships without a LICENSE file: node_modules/left-pad'), r.stderr);
});

test('THIRD_PARTY_NOTICES.md must list the exact bundled version', () => {
  const stale = GOOD_NOTICES.replace('| left-pad | 1.3.0 |', '| left-pad | 1.2.0 |');
  const r = run(packJson(), packageDir({ notices: stale }));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('THIRD_PARTY_NOTICES.md has no row for left-pad 1.3.0'), r.stderr);
});

test('a lockfile with no production packages fails', () => {
  const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/jest': { version: '29.0.0', dev: true } } };
  const r = run(packJson({ files: OWN }), packageDir({ lock }));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('package-lock.json lists no bundled dependencies'), r.stderr);
});

test('a bundleDependencies entry that is not in the tarball fails', () => {
  const r = run(packJson(), packageDir({ pkg: { bundleDependencies: ['ghost'] } }));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('bundleDependencies entry not in tarball: ghost'), r.stderr);
});

const FORBIDDEN = [
  ['test/index.test.js', 'test suite'],
  ['.env', 'env file'],
  ['config/.env.production', 'env file'],
  ['certs/server.pem', 'key or certificate'],
  ['keys/deploy.p12', 'key or certificate'],
  ['keys/id_ed25519', 'SSH key'],
  ['.npmrc', '.npmrc'],
  ['zn-gate-9.9.9.tgz', 'nested tarball'],
  ['node_modules/left-pad/index.js.map', 'source map of a bundled dependency'],
  ['node_modules/left-pad/src/index.ts', 'TypeScript source of a bundled dependency'],
];
for (const [path, what] of FORBIDDEN) {
  test(`a forbidden file in the tarball fails: ${path}`, () => {
    const r = run(packJson({ files: [...OWN, ...BUNDLED, path] }), packageDir());
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`error: unexpected ${what} in tarball: ${path}`), r.stderr);
  });
}

test('look-alike names are not forbidden', () => {
  const files = [...OWN, ...BUNDLED, 'dist/environment.js', 'docs/test-plan.md', 'node_modules/left-pad/index.d.ts'];
  const r = run(packJson({ files }), packageDir());
  assert.equal(r.status, 0, r.stderr);
});

test('pack output that is not JSON fails closed', () => {
  const r = run(packJson({ raw: 'npm ERR! something went wrong\n' }), packageDir());
  assert.notEqual(r.status, 0);
});

test('a bin written as a string shorthand is read as one target', { todo: 'known bug: Object.values() on a string bin splits it into characters, so a valid package fails with "missing required file: ."' }, () => {
  const r = run(packJson(), packageDir({ pkg: { bin: './bin/cli.js' } }));
  assert.equal(r.status, 0, r.stderr);
});
