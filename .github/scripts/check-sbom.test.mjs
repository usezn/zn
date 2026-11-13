// Tests for check-sbom.js: the CycloneDX SBOM written by the release build.
// Each test writes a small SBOM into a temp dir and runs the real CLI. No network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { serialFor } = require('./sbom-serial.js');
const SCRIPT = join(here, 'check-sbom.js');

const GOOD_SERIAL = 'urn:uuid:6f1c2e0a-8b7d-5c3e-9a4f-1e2d3c4b5a69';
const FILE_NAME = 'zn-gate-9.9.9.cdx.json';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'check-sbom-'));
  dirs.push(d);
  return d;
}

const COMPONENTS = [
  { type: 'library', name: 'left-pad', version: '1.3.0' },
  { type: 'library', name: 'ms', version: '2.1.3' },
];

// A valid bom; `extra` is merged over it, and a key set to undefined is left out.
function bom(extra = {}) {
  const base = {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: GOOD_SERIAL,
    version: 1,
    metadata: { component: { type: 'library', name: 'zn-gate', version: '9.9.9' } },
    components: COMPONENTS,
  };
  const merged = { ...base, ...extra };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged;
}

// `content` is written as-is when it is a string, otherwise as JSON.
function sbomFile(content) {
  const path = join(tempDir(), FILE_NAME);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

function run(file, version = '9.9.9') {
  return spawnSync(process.execPath, [SCRIPT, file, version], { encoding: 'utf8' });
}

test('a valid SBOM passes and reports the version and the number of dependencies', () => {
  const r = run(sbomFile(bom()));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${FILE_NAME}: zn-gate 9.9.9, 2 dependencies`);
});

test('the dependency count follows the components list', () => {
  const three = [...COMPONENTS, { type: 'library', name: 'semver', version: '7.6.0' }];
  assert.match(run(sbomFile(bom({ components: three }))).stdout, /, 3 dependencies/);
  assert.match(run(sbomFile(bom({ components: [] }))).stdout, /, 0 dependencies/);
});

test('a bom without a components key (a package with no dependencies) passes with zero', () => {
  const r = run(sbomFile(bom({ components: undefined })));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /, 0 dependencies/);
});

test('components that is not a list fails', () => {
  const r = run(sbomFile(bom({ components: { name: 'left-pad' } })));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('components is not a list'), r.stderr);
});

test('a bomFormat other than CycloneDX fails', () => {
  const r = run(sbomFile(bom({ bomFormat: 'SPDX' })));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('bomFormat is not CycloneDX'), r.stderr);
});

test('a specVersion other than 1.6 fails', () => {
  const r = run(sbomFile(bom({ specVersion: '1.5' })));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('specVersion is 1.5, not 1.6'), r.stderr);
});

test('a missing serialNumber fails, since attestations need one', () => {
  const r = run(sbomFile(bom({ serialNumber: undefined })));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('serialNumber is missing or is not a urn:uuid'), r.stderr);
});

test('a serialNumber that is a bare uuid, without the urn:uuid prefix, fails', () => {
  const r = run(sbomFile(bom({ serialNumber: GOOD_SERIAL.slice('urn:uuid:'.length) })));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('serialNumber is missing or is not a urn:uuid'), r.stderr);
});

test('a serialNumber must be a version 1-5 uuid with an RFC 4122 variant', () => {
  // version nibble 6 (third group starts with 6)
  const v6 = 'urn:uuid:6f1c2e0a-8b7d-6c3e-9a4f-1e2d3c4b5a69';
  // variant nibble c (fourth group starts with c)
  const badVariant = 'urn:uuid:6f1c2e0a-8b7d-5c3e-ca4f-1e2d3c4b5a69';
  for (const serialNumber of [v6, badVariant]) {
    const r = run(sbomFile(bom({ serialNumber })));
    assert.equal(r.status, 1, serialNumber);
    assert.ok(r.stderr.includes('serialNumber is missing or is not a urn:uuid'), r.stderr);
  }
  // a version 4 uuid is valid
  const v4 = 'urn:uuid:6f1c2e0a-8b7d-4c3e-9a4f-1e2d3c4b5a69';
  assert.equal(run(sbomFile(bom({ serialNumber: v4 }))).status, 0);
});

test('the serialNumber written by sbom-serial.js passes the check', () => {
  const sha = '0'.repeat(63) + '1';
  const serial = serialFor('zn-gate', '9.9.9', sha);
  const r = run(sbomFile(bom({ serialNumber: serial })));
  assert.equal(r.status, 0, r.stderr);
});

test('an SBOM that describes another package fails', () => {
  const other = bom({ metadata: { component: { type: 'library', name: 'other-tool', version: '9.9.9' } } });
  const r = run(sbomFile(other));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('describes other-tool, not zn-gate'), r.stderr);
});

test('an SBOM that describes another version fails', () => {
  const r = run(sbomFile(bom({ metadata: { component: { type: 'library', name: 'zn-gate', version: '9.9.8' } } })));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('describes version 9.9.8, not 9.9.9'), r.stderr);
});

test('an SBOM without metadata.component fails', () => {
  const r = run(sbomFile(bom({ metadata: {} })));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('metadata.component is missing'), r.stderr);
});

test('several problems are all reported in one run', () => {
  const r = run(sbomFile(bom({ bomFormat: 'SPDX', specVersion: '1.5', serialNumber: undefined })));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('bomFormat is not CycloneDX'), r.stderr);
  assert.ok(r.stderr.includes('specVersion is 1.5, not 1.6'), r.stderr);
  assert.ok(r.stderr.includes('serialNumber is missing or is not a urn:uuid'), r.stderr);
});

test('a file that is not JSON fails with a readable error', () => {
  const r = run(sbomFile('{ "bomFormat": '));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('is not readable JSON'), r.stderr);
});

test('usage: missing arguments exit 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: check-sbom\.js/);
});
