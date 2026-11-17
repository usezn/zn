'use strict';
// A system clock that is wrong (a long jump ahead, a step back) must not delete stored history or live session
// baselines, and must not freeze the reload of a changed rules file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-clock-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const rules = require('../lib/rules');
const { pruneState } = require('../lib/hooks/runner');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 3600 * 1000;
const at = (s) => new Date(`${s}T12:00:00Z`);
const entry = { layer: 'hook', agent: 'claude-code', checked: 1, blocked: 0, warned: 0, redacted: 0, detections: {} };

/* ---------------- stats ---------------- */

for (const ahead of [91, 120, 365, 399, 400, 800]) {
  test(`stats: a clock ${ahead} days ahead does not delete the history`, () => {
    const file = path.join(home, `stats-${ahead}.json`);
    stats.record(entry, { file, now: at('2026-01-10') });
    stats.record(entry, { file, now: at('2026-01-11') });
    const later = new Date(at('2026-01-11').getTime() + ahead * DAY);
    stats.record(entry, { file, now: later });
    const days = Object.keys(stats.load(file).days);
    assert.ok(days.includes('2026-01-10') && days.includes('2026-01-11'), 'old days kept: ' + days.join(','));
    assert.ok(days.includes(stats.today(later)));
    // and the next day under the same wrong clock still does not empty it
    stats.record(entry, { file, now: new Date(later.getTime() + DAY) });
    const after = Object.keys(stats.load(file).days);
    assert.ok(after.includes('2026-01-10') && after.includes('2026-01-11'), 'still kept: ' + after.join(','));
  });
}

test('stats: normal pruning still drops days older than 90 days', () => {
  const file = path.join(home, 'stats-normal.json');
  for (const d of ['2025-12-01', '2026-03-20', '2026-03-21', '2026-03-22']) stats.record(entry, { file, now: at(d) });
  stats.record(entry, { file, now: at('2026-03-23') });
  const days = Object.keys(stats.load(file).days);
  assert.ok(!days.includes('2025-12-01'), days.join(','));
  assert.ok(days.includes('2026-03-20'));
});

/* ---------------- session baselines ---------------- */

function stateDir() {
  const dir = fs.mkdtempSync(path.join(home, 'state-'));
  const mk = (name, ageMs) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, '[]');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
    return f;
  };
  return { dir, mk };
}

test('pruneState: removes a baseline older than 14 days while a recent one exists', () => {
  const { dir, mk } = stateDir();
  const old = mk('config-change-0123456789abcdef.json', 20 * DAY);
  const live = mk('config-change-fedcba9876543210.json', 1 * DAY);
  pruneState(dir);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(live));
});

test('pruneState: a clock far ahead (every file looks old) removes nothing', () => {
  const { dir, mk } = stateDir();
  const a = mk('config-change-0123456789abcdef.json', 2 * DAY);
  const b = mk('instructions-loaded-fedcba9876543210.json', 3 * DAY);
  const realNow = Date.now;
  Date.now = () => realNow() + 365 * DAY;
  try { pruneState(dir); } finally { Date.now = realNow; }
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

/* ---------------- custom rules reload ---------------- */

test('rules: a wall clock set back does not freeze the reload of a changed rules file', () => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(home, 'rules-'));
  const realNow = Date.now;
  const realHr = process.hrtime.bigint;
  try {
    fs.writeFileSync(path.join(dir, '.znrules'), 'strict\n');
    process.chdir(dir);
    assert.equal(rules.loadCustomConfig(true).strict, true);
    fs.writeFileSync(path.join(dir, '.znrules'), '# no strict now\n');
    // the wall clock goes back one year; 6 s really pass on the monotonic clock
    const base = realNow();
    Date.now = () => base - 365 * DAY;
    process.hrtime.bigint = () => realHr() + 6000n * 1000000n;
    assert.equal(rules.loadCustomConfig().strict, false, 'reloaded after 6 s of monotonic time');
  } finally {
    Date.now = realNow;
    process.hrtime.bigint = realHr;
    process.chdir(cwd);
    rules.loadCustomConfig(true);
  }
});

test('rules: within 5 s of monotonic time the cached rules are used, whatever the wall clock does', () => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(home, 'rules2-'));
  const realNow = Date.now;
  try {
    fs.writeFileSync(path.join(dir, '.znrules'), 'strict\n');
    process.chdir(dir);
    assert.equal(rules.loadCustomConfig(true).strict, true);
    fs.writeFileSync(path.join(dir, '.znrules'), '# changed\n');
    Date.now = () => realNow() + 365 * DAY;
    assert.equal(rules.loadCustomConfig().strict, true, 'a wall jump forward does not trigger a reload either');
  } finally {
    Date.now = realNow;
    process.chdir(cwd);
    rules.loadCustomConfig(true);
  }
});
