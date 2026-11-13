'use strict';
// recordEvent and summary, with a fixed clock and a temporary home directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-event-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_HOME;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');

const NOW = new Date('2026-03-15T12:00:00Z');
const file = () => path.join(home, '.zn', 'stats.json');
const reset = () => {
  delete process.env.ZN_STATS;
  fs.rmSync(path.join(home, '.zn'), { recursive: true, force: true });
};
const at = (daysAgo) => new Date(NOW.getTime() - daysAgo * 86400000);

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('recordEvent counts each event name separately', () => {
  reset();
  stats.recordEvent('planned-feature');
  stats.recordEvent('planned-feature');
  stats.recordEvent('other-thing');
  assert.deepEqual(stats.summary({ now: NOW }).events, { 'planned-feature': 2, 'other-thing': 1 });
});

test('recordEvent cleans the event name', () => {
  reset();
  stats.recordEvent('Some Name');
  stats.recordEvent('');
  assert.deepEqual(stats.summary({ now: NOW }).events, { 'some-name': 1, other: 1 });
});

test('ZN_STATS=off writes nothing', () => {
  reset();
  process.env.ZN_STATS = 'off';
  stats.recordEvent('planned-feature');
  stats.record({ layer: 'hook', agent: 'a', checked: 1 }, { now: NOW });
  assert.equal(fs.existsSync(file()), false);
  assert.equal(fs.existsSync(path.join(home, '.zn')), false);
  delete process.env.ZN_STATS;
});

test('a damaged stats file never throws and is replaced on the next write', () => {
  reset();
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  for (const bad of ['{not json', '', 'null', '[]', '{"days":"x"}']) {
    fs.writeFileSync(file(), bad);
    assert.doesNotThrow(() => stats.summary({ now: NOW }));
    assert.doesNotThrow(() => stats.recordEvent('x'));
    assert.doesNotThrow(() => stats.record({ layer: 'hook', checked: 1 }, { now: NOW }));
  }
  fs.writeFileSync(file(), '{not json');
  assert.equal(stats.summary({ now: NOW }).total.checked, 0);
  stats.recordEvent('after-damage');
  assert.deepEqual(stats.summary({ now: NOW }).events, { 'after-damage': 1 });
});

test('summary leaves out days outside the window', () => {
  reset();
  stats.record({ layer: 'hook', agent: 'a', checked: 1, blocked: 1, detections: { AWS_KEY: 1 } }, { now: at(0) });
  stats.record({ layer: 'hook', agent: 'a', checked: 2 }, { now: at(6) });
  stats.record({ layer: 'hook', agent: 'a', checked: 4, detections: { AWS_KEY: 5 } }, { now: at(7) });
  const s7 = stats.summary({ days: 7, now: NOW });
  assert.equal(s7.total.checked, 3);
  assert.equal(s7.total.blocked, 1);
  assert.equal(s7.since, '2026-03-09');
  assert.deepEqual(s7.detections, { AWS_KEY: 1 });
  const s8 = stats.summary({ days: 8, now: NOW });
  assert.equal(s8.total.checked, 7);
  assert.deepEqual(s8.detections, { AWS_KEY: 6 });
  const s1 = stats.summary({ days: 1, now: NOW });
  assert.equal(s1.total.checked, 1);
  assert.equal(s1.since, '2026-03-15');
});

test('summary of an empty home has zero totals and no first day', () => {
  reset();
  const s = stats.summary({ now: NOW });
  assert.equal(s.since, null);
  assert.deepEqual(s.total, { checked: 0, blocked: 0, warned: 0, redacted: 0 });
  assert.deepEqual(s.events, {});
});
