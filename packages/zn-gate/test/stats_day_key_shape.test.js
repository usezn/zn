'use strict';
// stats.summary counts only day keys that are real dates (YYYY-MM-DD). Other keys in the file are skipped,
// and the valid keys give the same totals as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-daykey-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const file = path.join(home, 'daykey.json');
const at = (s) => new Date(`${s}T12:00:00Z`);

test('summary skips day keys that are not YYYY-MM-DD dates and counts the valid ones', () => {
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    events: {},
    days: {
      '2026-02-10': { 'cli:a': { checked: 2 } },
      '2026-02-99': { 'cli:a': { checked: 50 } },
      '2026-02-30': { 'cli:a': { checked: 40 } },
      'not-a-date': { 'cli:a': { checked: 30 } },
      '2026-13-40': { 'cli:a': { checked: 20 } },
    },
  }));
  const s = stats.summary({ days: 30, now: at('2026-03-01'), file });
  assert.equal(s.total.checked, 2);
  assert.equal(s.since, '2026-02-10');
  assert.equal(s.byKey['cli:a'].checked, 2);
});
