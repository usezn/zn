'use strict';
// lib/stats.js: when the stats file holds more days than KEEP_DAYS, the next write trims it to the keep window.
// Fake data only; the home folder is a temporary folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-cap-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const DAY_MS = 86400000;
const NOW = new Date('2026-06-01T12:00:00Z');

test('a write trims a stats file holding many more days than KEEP_DAYS to the keep window', () => {
  const file = path.join(home, 'many-days.json');
  const days = {};
  // One day per calendar day for 300 days before NOW: well above the keep limit.
  for (let i = 0; i < 300; i += 1) {
    const day = stats.today(new Date(NOW.getTime() - i * DAY_MS));
    days[day] = { 'cli:claude': { checked: i + 1, blocked: 0, warned: 0, redacted: 0, detections: {} } };
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, events: {}, days }));

  stats.record({ layer: 'cli', agent: 'claude', checked: 1 }, { file, now: NOW });

  const kept = Object.keys(stats.load(file).days).sort();
  const cutoff = stats.today(new Date(NOW.getTime() - stats.KEEP_DAYS * DAY_MS));
  const oldest = kept[0];
  const newest = kept[kept.length - 1];
  assert.ok(stats.KEEP_DAYS > 0 && stats.KEEP_DAYS < 300, 'the fixture must exceed the keep limit');
  assert.equal(newest, stats.today(NOW));
  assert.equal(oldest, cutoff, 'the oldest kept day is the keep-window cutoff');
  // Inclusive window: KEEP_DAYS days before today plus today itself.
  assert.equal(kept.length, stats.KEEP_DAYS + 1);
  assert.ok(kept.length < 300);
});
