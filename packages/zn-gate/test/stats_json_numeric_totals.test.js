'use strict';
// zn-gate stats --json: every total and count is a finite number, with an empty history and with recorded events.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-numeric-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const cli = require('../lib/stats-cli');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const reset = () => { for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true }); };
const runJson = async (args = []) => {
  let out = '';
  const code = await cli.run(['--json', ...args], (s) => { out += s; }, { confirm: async () => false });
  assert.equal(code, 0, args.join(' '));
  return JSON.parse(out);
};
const isNum = (v, where) => {
  assert.equal(typeof v, 'number', where);
  assert.ok(Number.isFinite(v), where);
};

function assertCountsAreNumbers(j, where) {
  assert.deepEqual(Object.keys(j.total).sort(), ['blocked', 'checked', 'redacted', 'warned'], where);
  for (const [field, v] of Object.entries(j.total)) isNum(v, `${where} total.${field}`);
  for (const [key, c] of Object.entries(j.byKey)) {
    for (const field of ['checked', 'blocked', 'warned', 'redacted']) isNum(c[field], `${where} byKey.${key}.${field}`);
  }
  for (const [type, n] of Object.entries(j.detections)) isNum(n, `${where} detections.${type}`);
  for (const [name, n] of Object.entries(j.events)) isNum(n, `${where} events.${name}`);
  for (const r of j.top_rules) isNum(r.count, `${where} top_rules.${r.id}`);
  isNum(j.days, `${where} days`);
  isNum(j.top_rules_days, `${where} top_rules_days`);
  isNum(j.send_failed, `${where} send_failed`);
}

test('an empty history prints every total as the number 0', async () => {
  for (const args of [[], ['--days', '1'], ['--days', '90']]) {
    reset();
    fs.mkdirSync(path.dirname(stats.statsFile()), { recursive: true });
    fs.writeFileSync(stats.statsFile(), JSON.stringify({ version: 1, days: {}, events: {} }));
    const j = await runJson(args);
    assertCountsAreNumbers(j, args.join(' ') || 'default');
    assert.deepEqual(j.total, { checked: 0, blocked: 0, warned: 0, redacted: 0 }, args.join(' ') || 'default');
    assert.equal(j.since, null);
  }
});

test('a missing stats file prints every total as the number 0', async () => {
  reset();
  const j = await runJson();
  assertCountsAreNumbers(j, 'missing file');
  assert.deepEqual(j.total, { checked: 0, blocked: 0, warned: 0, redacted: 0 });
});

test('recorded events keep every total, count and event counter a number', async () => {
  reset();
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 3, blocked: 1, redacted: 2, detections: { AWS_KEY: 2 } });
  stats.record({ layer: 'mcp', agent: 'cursor', checked: 1, blocked: 0, detections: {} });
  stats.recordEvent('install');
  stats.recordEvent('install');
  const j = await runJson();
  assertCountsAreNumbers(j, 'recorded');
  assert.deepEqual(j.total, { checked: 4, blocked: 1, warned: 0, redacted: 2 });
  assert.equal(j.byKey['hook:claude-code'].checked, 3);
  assert.equal(j.byKey['mcp:cursor'].blocked, 0);
  assert.equal(j.events.install, 2);
  assert.deepEqual(j.detections, { AWS_KEY: 2 });
  assert.equal(j.top_rules[0].count, 2);
});
