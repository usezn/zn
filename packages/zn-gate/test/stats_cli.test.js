'use strict';
// zn-gate stats command line: argument parsing, an empty stats file, the --json shape and the unknown-flag message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-cli-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const cli = require('../lib/stats-cli');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const reset = () => { for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true }); };
const run = async (args) => { let out = ''; const code = await cli.run(args, (s) => { out += s; }, { confirm: async () => false }); return { code, out }; };

const USAGE_START = 'Usage: zn-gate stats [--days 1-90] [--json]';

test('an unknown flag prints the usage text and exits with 2', async () => {
  reset();
  const r = await run(['--bogus']);
  assert.equal(r.code, 2);
  assert.ok(r.out.startsWith(USAGE_START));
  assert.match(r.out, /stats share on\|off\|status\|show/);
});

test('bad --days values and stray words are rejected with the usage text', async () => {
  reset();
  for (const args of [['--days', '0'], ['--days', '91'], ['--days', 'abc'], ['--days'], ['--days', '1.5'], ['hello']]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.out.startsWith(USAGE_START), args.join(' '));
  }
});

test('--days accepts the whole range 1 to the retention limit', async () => {
  reset();
  for (const n of [1, 30, stats.KEEP_DAYS]) {
    const r = await run(['--days', String(n), '--json']);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).days, n);
  }
});

test('the default window is 30 days and flags may come in any order', async () => {
  reset();
  assert.equal(JSON.parse((await run(['--json'])).out).days, 30);
  assert.equal(JSON.parse((await run(['--json', '--days', '7'])).out).days, 7);
  assert.equal(JSON.parse((await run(['--days', '7', '--json'])).out).days, 7);
});

test('with no stats file the summary says nothing is recorded yet', async () => {
  reset();
  assert.equal(fs.existsSync(stats.statsFile()), false);
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /last 30 days/);
  assert.match(r.out, /Nothing recorded yet/);
  assert.doesNotMatch(r.out, /events checked/);
});

test('an empty or damaged stats file is treated like no data', async () => {
  for (const content of ['', '{}', 'not json', '[]']) {
    reset();
    fs.writeFileSync(stats.statsFile(), content);
    const r = await run([]);
    assert.equal(r.code, 0, JSON.stringify(content));
    assert.match(r.out, /Nothing recorded yet/);
  }
});

test('--days 1 uses the singular "day" in the heading', async () => {
  reset();
  assert.match((await run(['--days', '1'])).out, /last 1 day[^s]/);
});

test('--json on an empty file has the documented shape with zero counts', async () => {
  reset();
  const r = await run(['--json']);
  assert.equal(r.code, 0);
  assert.ok(r.out.endsWith('\n'));
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j).sort(), ['byKey', 'days', 'detections', 'events', 'send_failed', 'sent_days', 'sharing', 'since', 'total']);
  assert.equal(j.days, 30);
  assert.equal(j.since, null);
  assert.deepEqual(j.total, { checked: 0, blocked: 0, warned: 0, redacted: 0 });
  assert.deepEqual(j.byKey, {});
  assert.deepEqual(j.detections, {});
  assert.equal(j.sharing, false);
  assert.deepEqual(j.sent_days, []);
  assert.equal(j.send_failed, 0);
});

test('--json reports recorded counts and prints no human text', async () => {
  reset();
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 2, blocked: 1, detections: { AWS_KEY: 1 } });
  const r = await run(['--json']);
  assert.ok(r.out.startsWith('{'));
  const j = JSON.parse(r.out);
  assert.equal(j.total.checked, 2);
  assert.equal(j.total.blocked, 1);
  assert.deepEqual(j.byKey['hook:claude-code'].checked, 2);
  assert.deepEqual(j.detections, { AWS_KEY: 1 });
  assert.match(j.since, /^\d{4}-\d{2}-\d{2}$/);
});

test('the human summary lists the agent and secret types that were recorded', async () => {
  reset();
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 2, blocked: 1, detections: { AWS_KEY: 1 } });
  const r = await run([]);
  assert.match(r.out, /2 events checked/);
  assert.match(r.out, /1 blocked/);
  assert.match(r.out, /Secret types found: AWS_KEY 1/);
  assert.match(r.out, /claude-code \(agent hooks\): 2 events, 1 blocked/);
});
