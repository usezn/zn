'use strict';

// The state files the CLI writes go through the package's exclusive writer: a file planted at the old, predictable
// temporary name is neither followed nor overwritten, and a failed write leaves no temporary file behind.
// Values are fake.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { saveBaseline, baselinePath } = require('../lib/audit/baseline');
const { takeNotices } = require('../lib/team/changes');
const { writeTeam } = require('../lib/team/policy');
const { uploadPending } = require('../lib/team/upload');
const stats = require('../lib/stats');
const { tempDir } = require('./helpers/tmp');

const PLANTED = 'planted by another process, must survive';

// Temporary files left in a folder: the old pid-named ones and the exclusive writer's own.
function leftovers(dir) {
  return fs.readdirSync(dir).filter((f) => /\.tmp$|\.zn-tmp$/.test(f));
}

test('a baseline write leaves a file planted at the old temporary name alone', (t) => {
  const home = tempDir(t, 'zn-state-home-');
  const root = tempDir(t, 'zn-state-root-');
  const file = baselinePath(home, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const planted = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(planted, PLANTED);

  saveBaseline(home, root, { 'package.json#script:test': 'a'.repeat(64) }, new Date('2026-11-18T00:00:00Z'));

  assert.equal(fs.readFileSync(planted, 'utf8'), PLANTED);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  assert.deepEqual(leftovers(path.dirname(file)), [path.basename(planted)]);
});

test('a failed baseline write throws and leaves no temporary file behind', (t) => {
  const home = tempDir(t, 'zn-state-home-');
  const root = tempDir(t, 'zn-state-root-');
  const file = baselinePath(home, root);
  // A folder at the target makes the final rename fail after the temporary file was written.
  fs.mkdirSync(file, { recursive: true });

  assert.throws(() => saveBaseline(home, root, {}, new Date('2026-11-18T00:00:00Z')));
  assert.deepEqual(leftovers(path.dirname(file)), []);
});

test('a notice write leaves a file planted at the old temporary name alone', (t) => {
  const home = tempDir(t, 'zn-state-home-');
  const planted = path.join(home, 'team-notice.json.' + process.pid + '.tmp');
  fs.writeFileSync(planted, PLANTED);

  takeNotices({ home, detectorsMissing: true, syncCommand: 'zn team sync', now: 1000 });

  assert.equal(fs.readFileSync(planted, 'utf8'), PLANTED);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'team-notice.json'), 'utf8')).detectors_at, 1000);
});

test('a failed notice write is swallowed and leaves no temporary file behind', (t) => {
  const home = tempDir(t, 'zn-state-home-');
  // A folder at the notice path makes the final rename fail.
  fs.mkdirSync(path.join(home, 'team-notice.json'));

  assert.doesNotThrow(() => takeNotices({ home, detectorsMissing: true, syncCommand: 'zn team sync', now: 1000 }));
  assert.deepEqual(leftovers(home), []);
});

test('a usage record is written to its file and leaves no temporary file behind', (t) => {
  const dir = tempDir(t, 'zn-state-stats-');
  const file = path.join(dir, 'stats.json');
  process.env.ZN_STATS = 'on';
  try {
    stats.record({ agent: 'claude-code', layer: 'cli', checked: 1 }, { file, now: new Date('2026-11-18T12:00:00Z') });
  } finally {
    process.env.ZN_STATS = 'off';
  }
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).days);
  assert.deepEqual(leftovers(dir), []);
});

test('a failed usage record is swallowed and leaves no temporary file behind', (t) => {
  const dir = tempDir(t, 'zn-state-stats-');
  const file = path.join(dir, 'stats.json');
  fs.mkdirSync(file);
  process.env.ZN_STATS = 'on';
  try {
    assert.doesNotThrow(() => stats.record({ agent: 'claude-code', layer: 'cli', checked: 1 }, { file, now: new Date('2026-11-18T12:00:00Z') }));
  } finally {
    process.env.ZN_STATS = 'off';
  }
  assert.deepEqual(leftovers(dir), []);
});

test('a team policy write lands in its file and leaves no temporary file behind', (t) => {
  const home = tempDir(t, 'zn-state-team-');
  writeTeam({ org: 'example-org' }, { home });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'team.json'), 'utf8')).org, 'example-org');
  assert.deepEqual(leftovers(home), []);
});

test('a failed team policy write throws and leaves no temporary file behind', (t) => {
  const home = tempDir(t, 'zn-state-team-');
  fs.mkdirSync(path.join(home, 'team.json'));
  assert.throws(() => writeTeam({ org: 'example-org' }, { home }));
  assert.deepEqual(leftovers(home), []);
});

test('an upload state write lands in its file and leaves no temporary file behind', async (t) => {
  const dir = tempDir(t, 'zn-state-upload-');
  const audit = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(audit, '');
  const stateFile = path.join(dir, 'state.json');
  const r = await uploadPending({ auditFile: audit, stateFile, lockFile: path.join(dir, 'lock'), installId: 'fake-install', api: { ingest: async () => ({ ok: true }) }, now: () => 1000 });
  assert.equal(r.status, 'nothing');
  assert.ok(fs.existsSync(stateFile));
  assert.deepEqual(leftovers(dir), []);
});

test('a failed upload state write is reported as an error and leaves no temporary file behind', async (t) => {
  const dir = tempDir(t, 'zn-state-upload-');
  const audit = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(audit, '');
  const stateFile = path.join(dir, 'state.json');
  fs.mkdirSync(stateFile);
  const r = await uploadPending({ auditFile: audit, stateFile, lockFile: path.join(dir, 'lock'), installId: 'fake-install', api: { ingest: async () => ({ ok: true }) }, now: () => 1000 });
  assert.equal(r.status, 'error');
  assert.deepEqual(leftovers(dir), []);
});
