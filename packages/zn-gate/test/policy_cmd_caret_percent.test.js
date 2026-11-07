'use strict';

// Regression tests for reading a .env through cmd.exe caret escapes and percent forms. Static strings only: the policy reads the
// text and never runs it. Values are fake. Cases are grouped by the decision the policy gives today; a dangerous form that is
// still allowed is a TODO known gap (not weakened, not skipped), so the owner can fix the policy and flip it.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

function asPlatform(name, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function project() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cmd-caret-pct-'));
  created.push(home);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.env'), 'API_TOKEN=fake-value-not-a-secret-0001\n');
  fs.writeFileSync(path.join(proj, 'README.md'), 'readme\n');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'notes\n');
  return { proj, opts: { home, cwd: proj, env: { HOME: home, PATH: '/usr/bin:/bin', EMPTY: '' } } };
}

const DENIED = /holds plain-text|was not read because|builds the path of a .env file/;

const BLOCKED = [
  'type .e^nv',
  'ty^pe .env',
  'type %CD%\.env',
  'type .%EMPTY%env',
  'cmd /c "type .e^nv"',
  'more < .e^nv',
  'findstr . .e^nv',
];

const ALLOWED = ['type README.md', 'echo 100%', 'type notes^.txt', 'type %CD%\README.md', 'echo %EMPTY%', 'findstr . README.md', 'more < README.md'];

function decide(c, platform) {
  const { opts } = project();
  return asPlatform(platform, () => policy.bashDenial(c, opts) || '');
}

// Dangerous forms the policy allows today. Empty means every case below is blocked.
const GAPS = new Set([]);

for (const c of BLOCKED) {
  test('win32: blocked: ' + c, GAPS.has(c) ? { todo: 'known gap: allowed today, a .env read through cmd.exe syntax' } : {}, () => {
    assert.match(decide(c, 'win32'), DENIED, c);
  });
}

// Once cmd is named, the caret is cmd syntax on any system.
test('linux: blocked once cmd is named: cmd /c "type .e^nv"', () => {
  assert.match(decide('cmd /c "type .e^nv"', 'linux'), DENIED);
});

for (const c of ALLOWED) {
  test('win32: allowed look-alike: ' + c, () => {
    assert.equal(decide(c, 'win32'), '', c);
  });
}
