'use strict';
// zn-gate stats: daily totals, empty days, UTC day boundaries (also under Europe/Madrid) and the text summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-days-test-'));
process.env.ZN_HOME = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const cli = require('../lib/stats-cli');

const realTZ = process.env.TZ;
test.after(() => {
  if (realTZ === undefined) delete process.env.TZ; else process.env.TZ = realTZ;
  fs.rmSync(home, { recursive: true, force: true });
});
const reset = () => { for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { force: true }); };
const text = async (args) => { let out = ''; await cli.run(args, (s) => { out += s; }, { confirm: async () => false }); return out; };

test('totals add up within a day and stay apart between days', () => {
  reset();
  const d1 = new Date('2026-03-10T08:00:00Z');
  const d2 = new Date('2026-03-11T08:00:00Z');
  stats.record({ layer: 'hook', agent: 'agent-a', checked: 2, blocked: 1 }, { now: d1 });
  stats.record({ layer: 'hook', agent: 'agent-a', checked: 3, warned: 1 }, { now: d1 });
  stats.record({ layer: 'hook', agent: 'agent-a', checked: 4 }, { now: d2 });
  const data = stats.load();
  assert.equal(data.days['2026-03-10']['hook:agent-a'].checked, 5);
  assert.equal(data.days['2026-03-10']['hook:agent-a'].blocked, 1);
  assert.equal(data.days['2026-03-10']['hook:agent-a'].warned, 1);
  assert.equal(data.days['2026-03-11']['hook:agent-a'].checked, 4);
  assert.equal(stats.summary({ days: 1, now: d2 }).total.checked, 4);
  assert.equal(stats.summary({ days: 2, now: d2 }).total.checked, 9);
});

test('days without records are skipped and an empty file gives zero totals', () => {
  reset();
  const empty = stats.summary({ days: 7, now: new Date('2026-03-10T12:00:00Z') });
  assert.deepEqual(empty.total, { checked: 0, blocked: 0, warned: 0, redacted: 0 });
  assert.equal(empty.since, null);
  stats.record({ layer: 'cli', agent: 'agent-a', checked: 1 }, { now: new Date('2026-03-01T12:00:00Z') });
  stats.record({ layer: 'cli', agent: 'agent-a', checked: 1 }, { now: new Date('2026-03-10T12:00:00Z') });
  const s = stats.summary({ days: 10, now: new Date('2026-03-10T12:00:00Z') });
  assert.equal(s.total.checked, 2);
  assert.equal(s.since, '2026-03-01');
  assert.equal(Object.keys(stats.load().days).length, 2);
  const recent = stats.summary({ days: 3, now: new Date('2026-03-10T12:00:00Z') });
  assert.equal(recent.total.checked, 1);
  assert.equal(recent.since, '2026-03-10');
});

for (const tz of ['UTC', 'Europe/Madrid']) {
  test(`day keys are UTC dates around midnight (TZ=${tz})`, () => {
    process.env.TZ = tz;
    reset();
    // 23:30 UTC on 2026-07-14 is already 01:30 on the 15th in Madrid (summer time); the key stays UTC.
    assert.equal(stats.today(new Date('2026-07-14T23:30:00Z')), '2026-07-14');
    assert.equal(stats.today(new Date('2026-07-15T00:00:00Z')), '2026-07-15');
    assert.equal(stats.today(new Date('2026-07-14T22:59:59.999Z')), '2026-07-14');
    // Winter time (UTC+1): 23:30 UTC on 2026-01-31 is 00:30 on 1 February in Madrid.
    assert.equal(stats.today(new Date('2026-01-31T23:30:00Z')), '2026-01-31');
    stats.record({ layer: 'hook', agent: 'agent-a', checked: 1 }, { now: new Date('2026-07-14T23:30:00Z') });
    stats.record({ layer: 'hook', agent: 'agent-a', checked: 1 }, { now: new Date('2026-07-15T00:30:00Z') });
    assert.deepEqual(Object.keys(stats.load().days).sort(), ['2026-07-14', '2026-07-15']);
    // A window of one day at 00:30 UTC covers only the new UTC day.
    assert.equal(stats.summary({ days: 1, now: new Date('2026-07-15T00:30:00Z') }).total.checked, 1);
  });
}

test('the summary window spans the daylight saving change by UTC days', () => {
  process.env.TZ = 'Europe/Madrid';
  reset();
  // Madrid clocks went forward on 2026-03-29; that day is still 24 hours in UTC.
  for (const d of ['2026-03-28', '2026-03-29', '2026-03-30']) stats.record({ layer: 'hook', agent: 'agent-a', checked: 1 }, { now: new Date(`${d}T12:00:00Z`) });
  const s = stats.summary({ days: 3, now: new Date('2026-03-30T12:00:00Z') });
  assert.equal(s.total.checked, 3);
  assert.equal(s.since, '2026-03-28');
});

test('text summary: empty file', async () => {
  reset();
  const out = await text([]);
  assert.match(out, /^zn-gate on this machine, last 30 days:\n\n/);
  assert.match(out, /Nothing recorded yet\./);
  assert.doesNotMatch(out, /events checked/);
});

test('text summary: totals, types and agents with fake data', async () => {
  reset();
  const now = new Date();
  stats.record({ layer: 'hook', agent: 'agent-a', checked: 1200, blocked: 3, redacted: 7, warned: 2, detections: { AWS_KEY: 4, GITHUB_TOKEN: 6 } }, { now });
  stats.record({ layer: 'mcp', agent: 'agent-b', checked: 10 }, { now });
  const out = await text(['--days', '7']);
  assert.match(out, /^zn-gate on this machine, last 7 days \(counting since \d{4}-\d{2}-\d{2}\):\n\n/);
  assert.match(out, /1,?210 events checked/);
  assert.match(out, /\n  3 blocked /);
  assert.match(out, /\n  7 secret values replaced before the model saw them\n/);
  assert.match(out, /\n  2 warnings\n/);
  assert.match(out, /Secret types found: GITHUB_TOKEN 6, AWS_KEY 4\n/);
  assert.match(out, /By agent:\n    agent-a \(.+\): 1,?200 events, 3 blocked, 7 replaced\n    agent-b \(.+\): 10 events, 0 blocked, 0 replaced\n/);
  assert.match(out, /stay on this machine/);
});

test('text summary: one day uses the singular and no warnings line when there are none', async () => {
  reset();
  stats.record({ layer: 'cli', agent: 'agent-a', checked: 1 }, { now: new Date() });
  const out = await text(['--days', '1']);
  assert.match(out, /last 1 day \(counting since/);
  assert.doesNotMatch(out, /warnings/);
});
