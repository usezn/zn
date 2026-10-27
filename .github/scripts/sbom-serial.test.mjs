// Tests for sbom-serial.js and the serialNumber rule in check-sbom.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { uuidV5, serialFor, withSerial } = require('./sbom-serial.js');
const SERIAL = join(here, 'sbom-serial.js');
const CHECK = join(here, 'check-sbom.js');

const bom = (extra = {}) => ({
  $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: { component: { type: 'library', name: 'zn-gate', version: '9.9.9' } },
  components: [],
  ...extra,
});

function fixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sbom-serial-'));
  const sbom = join(dir, 'zn-gate-9.9.9.cdx.json');
  const artifact = join(dir, 'zn-gate-9.9.9.tgz');
  writeFileSync(sbom, JSON.stringify(content, null, 2) + '\n');
  writeFileSync(artifact, 'fictitious tarball bytes');
  return { sbom, artifact };
}

test('uuidV5 matches the RFC 4122 example (python.org in the DNS namespace)', () => {
  assert.equal(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
});

test('the serial number is deterministic and depends on name, version and artifact hash', () => {
  const a = serialFor('zn-gate', '1.0.0', 'a'.repeat(64));
  assert.equal(a, serialFor('zn-gate', '1.0.0', 'a'.repeat(64)));
  assert.match(a, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, serialFor('zn-gate', '1.0.1', 'a'.repeat(64)));
  assert.notEqual(a, serialFor('zn-gate', '1.0.0', 'b'.repeat(64)));
});

test('serialNumber goes right after specVersion and the other keys keep their order', () => {
  const keys = Object.keys(withSerial(bom(), 'urn:uuid:x'));
  assert.deepEqual(keys, ['$schema', 'bomFormat', 'specVersion', 'serialNumber', 'version', 'metadata', 'components']);
  assert.equal(withSerial(bom({ serialNumber: 'old' }), 'urn:uuid:new').serialNumber, 'urn:uuid:new');
});

test('the script writes the same SBOM twice for the same artifact, and check-sbom accepts it', () => {
  const { sbom, artifact } = fixture(bom());
  execFileSync(process.execPath, [SERIAL, sbom, artifact]);
  const first = readFileSync(sbom, 'utf8');
  execFileSync(process.execPath, [SERIAL, sbom, artifact]);
  assert.equal(readFileSync(sbom, 'utf8'), first);
  assert.match(JSON.parse(first).serialNumber, /^urn:uuid:/);
  assert.ok(first.endsWith('\n'));
  execFileSync(process.execPath, [CHECK, sbom, '9.9.9']);
});

test('check-sbom refuses an SBOM without serialNumber (GitHub attestations reject it)', () => {
  const { sbom } = fixture(bom());
  const r = spawnSync(process.execPath, [CHECK, sbom, '9.9.9'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /serialNumber/);
});

test('check-sbom refuses a serialNumber that is not a urn:uuid', () => {
  const { sbom } = fixture(bom({ serialNumber: 'abc' }));
  const r = spawnSync(process.execPath, [CHECK, sbom, '9.9.9'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /serialNumber/);
});
