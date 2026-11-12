'use strict';
// `zn-gate stats --days 30` counts only the last 30 day keys (today included) out of a longer history.
// The stats file is a throwaway fixture in a temporary home; the real one is never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-window-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const cli = require('../lib/stats-cli');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const DAY = 86400000;
const NOW = new Date('2026-06-30T12:00:00Z');
const dayKey = (ago, base = NOW) => new Date(base.getTime() - ago * DAY).toISOString().slice(0, 10);

// One check on each of the last 60 days (0 = today, 59 = 59 days ago).
function writeFixture(base = NOW) {
  const days = {};
  for (let ago = 0; ago < 60; ago++) {
    days[dayKey(ago, base)] = { 'hook:claude-code': { checked: 1, blocked: 0, warned: 0, redacted: 0, detections: {} } };
  }
  fs.writeFileSync(stats.statsFile(), JSON.stringify({ version: 1, days, events: {} }));
}

test('summary over 30 days keeps exactly the last 30 day keys', () => {
  writeFixture();
  const s = stats.summary({ days: 30, now: NOW });
  assert.equal(s.days, 30);
  assert.equal(s.total.checked, 30);
  assert.equal(s.since, dayKey(29));
});

test('the day just outside the window is not counted', () => {
  writeFixture();
  assert.equal(stats.summary({ days: 30, now: NOW }).total.checked, 30);
  assert.equal(stats.summary({ days: 31, now: NOW }).total.checked, 31);
  assert.equal(stats.summary({ days: 1, now: NOW }).total.checked, 1);
});

test('the command with --days 30 --json reports a 30-day window over a longer history', async () => {
  writeFixture(new Date());
  let out = '';
  const code = await cli.run(['--days', '30', '--json'], (s) => { out += s; }, { confirm: async () => false });
  assert.equal(code, 0);
  const j = JSON.parse(out);
  assert.equal(j.days, 30);
  // The command uses the real clock, so the fixture is built around today: 30 of the 60 days fall inside.
  assert.equal(j.total.checked, 30);
});
