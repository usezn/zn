'use strict';
// lib/stats.js with day keys that are not dates: the file loads without throwing,
// and the malformed entries do not count in the summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-badday-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const file = path.join(home, 'badday.json');
const at = (s) => new Date(`${s}T12:00:00Z`);

function writeFile() {
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    events: {},
    days: {
      'yesterday': { 'cli:a': { checked: 100 } },
      '2026-13-45': { 'cli:a': { checked: 100 } },
      '2026-03-01': { 'cli:a': { checked: 2 } },
    },
  }));
}

test('load of a stats file with malformed day keys does not throw', () => {
  writeFile();
  let d;
  assert.doesNotThrow(() => { d = stats.load(file); });
  assert.equal(d.days['2026-03-01']['cli:a'].checked, 2);
});

test('summary ignores the malformed day keys and counts only real dates', () => {
  writeFile();
  const s = stats.summary({ days: 30, now: at('2026-03-01'), file });
  assert.equal(s.total.checked, 2);
  assert.equal(s.since, '2026-03-01');
});
