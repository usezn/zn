'use strict';

// The state files the CLI writes (the audit baseline, the team notice) go through the package's exclusive writer:
// a file planted at the old, predictable temporary name is neither followed nor overwritten, and a failed write
// leaves no temporary file behind. Values are fake.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { saveBaseline, baselinePath } = require('../lib/audit/baseline');
const { takeNotices } = require('../lib/team/changes');
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
