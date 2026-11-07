'use strict';
// zn-gate stats Top rules: a fixture ledger with made-up counts gives the expected top five and ordering,
// in text and --json, with ids only, for the 7-day default and for --days N.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-top-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const cli = require('../lib/stats-cli');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const run = async (args) => { let out = ''; const code = await cli.run(args, (s) => { out += s; }, { confirm: async () => false }); return { code, out }; };
const dayAgo = (n) => stats.today(new Date(Date.now() - n * 86400000));
const entry = (detections) => ({ checked: 5, blocked: 1, warned: 0, redacted: 1, detections });

function writeLedger(days) {
  fs.writeFileSync(stats.statsFile(), JSON.stringify({ version: 1, days, events: {} }));
}

// Recent days: AWS_KEY 9, GITHUB_TOKEN 4 + 4 (tie with nothing), DB_PASSWORD 4, JWT 3, EMAIL 2, SSN 1 (sixth: cut).
// Ten days ago: STRIPE_KEY 50, which only a window longer than 7 days may count.
function fixture() {
  writeLedger({
    [dayAgo(1)]: { 'hook:claude-code': entry({ AWS_KEY: 6, GITHUB_TOKEN: 4, DB_PASSWORD: 4, JWT: 3 }) },
    [dayAgo(2)]: { 'hook:cursor': entry({ AWS_KEY: 3, EMAIL: 2, SSN: 1 }) },
    [dayAgo(10)]: { 'hook:cursor': entry({ STRIPE_KEY: 50 }) },
  });
}

test('topRules: highest count first, ties by id, at most five, 7 days by default', () => {
  fixture();
  const top = stats.topRules();
  assert.deepEqual(top.map((r) => [r.id, r.count]), [['AWS_KEY', 9], ['DB_PASSWORD', 4], ['GITHUB_TOKEN', 4], ['JWT', 3], ['EMAIL', 2]]);
  for (const r of top) assert.equal(typeof r.name, 'string');
});

test('topRules: a longer window counts older days', () => {
  fixture();
  const top = stats.topRules({ days: 30 });
  assert.deepEqual(top[0], { id: 'STRIPE_KEY', name: top[0].name, count: 50 });
});

test('text output: Top rules block over 7 days by default, with a hint, ids and counts only', async () => {
  fixture();
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Top rules, last 7 days:/);
  assert.match(r.out, /AWS_KEY {2}\S.* {2}9\n/);
  assert.ok(r.out.indexOf('AWS_KEY  ') < r.out.indexOf('DB_PASSWORD  '));
  assert.ok(r.out.indexOf('DB_PASSWORD  ') < r.out.indexOf('GITHUB_TOKEN  '));
  assert.doesNotMatch(r.out, /SSN {2}/);
  assert.doesNotMatch(r.out, /STRIPE_KEY {2}/);
  assert.match(r.out, /Most frequent: AWS_KEY\. To understand a block, see https:\/\/usezn\.com\/docs\//);
});

test('--days N sets the Top rules window', async () => {
  fixture();
  const r = await run(['--days', '30']);
  assert.match(r.out, /Top rules, last 30 days:/);
  assert.match(r.out, /Most frequent: STRIPE_KEY\./);
  const two = await run(['--days', '2']);
  assert.match(two.out, /Top rules, last 2 days:/);
  assert.doesNotMatch(two.out, /EMAIL {2}/);
});

test('--json carries top_rules and top_rules_days', async () => {
  fixture();
  const j = JSON.parse((await run(['--json'])).out);
  assert.equal(j.top_rules_days, 7);
  assert.deepEqual(j.top_rules.map((r) => r.id), ['AWS_KEY', 'DB_PASSWORD', 'GITHUB_TOKEN', 'JWT', 'EMAIL']);
  for (const r of j.top_rules) assert.deepEqual(Object.keys(r).sort(), ['count', 'id', 'name']);
  const j30 = JSON.parse((await run(['--json', '--days', '30'])).out);
  assert.equal(j30.top_rules_days, 30);
  assert.equal(j30.top_rules[0].id, 'STRIPE_KEY');
});

test('no detections: no Top rules block and an empty list in --json', async () => {
  writeLedger({ [dayAgo(1)]: { 'hook:cursor': entry({}) } });
  const r = await run([]);
  assert.doesNotMatch(r.out, /Top rules/);
  assert.deepEqual(JSON.parse((await run(['--json'])).out).top_rules, []);
});

test('ids that are not detector ids are never shown', () => {
  writeLedger({ [dayAgo(1)]: { 'hook:cursor': entry({ 'not an id/with path': 5, AWS_KEY: 1 }) } });
  assert.deepEqual(stats.topRules().map((r) => r.id), ['AWS_KEY']);
});
