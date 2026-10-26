'use strict';
// lib/stats-share.js: the report built from a fixed stats object (preview mode, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-share-report-'));
process.env.ZN_HOME = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const share = require('../lib/stats-share');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const NOW = new Date('2026-10-14T12:00:00Z');
const write = (days) => fs.writeFileSync(stats.statsFile(), JSON.stringify({ version: 1, days, events: {} }));
const preview = () => share.pendingReports(NOW, { preview: true });

test('builds the report text from a fixed stats object', () => {
  write({
    '2026-10-13': {
      'hook:claude-code': { checked: 10, blocked: 2, detections: { aws_key: 2, JWT: 1 } },
      'mcp:codex': { checked: 3, blocked: 0, detections: { aws_key: 1 } },
    },
  });
  const reports = preview();
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.install_id, '<random id>');
  assert.equal(r.day, '2026-10-13');
  assert.equal(r.layer, 'hook');
  assert.equal(r.agent, 'claude-code');
  assert.deepEqual(r.detections, { AWS_KEY: 3, JWT: 1 });
  assert.deepEqual(Object.keys(r).sort(),
    ['agent', 'day', 'detections', 'install_id', 'layer', 'node_major', 'os', 'zn_gate_version']);
});

test('zero counts leave out the detections field, and days with no entries are skipped', () => {
  write({
    '2026-10-12': { 'hook:codex': { checked: 5, blocked: 0, detections: { aws_key: 0, jwt: -2 } } },
    '2026-10-13': { 'cli:cursor': { checked: 0, blocked: 0 } },
    '2026-10-11': {},
  });
  const reports = preview();
  assert.deepEqual(reports.map((r) => r.day), ['2026-10-12', '2026-10-13']);
  for (const r of reports) assert.equal('detections' in r, false);
});

test('today and days older than three days are not reported', () => {
  const entry = { 'hook:codex': { checked: 1, blocked: 0, detections: { jwt: 1 } } };
  write({ '2026-10-10': entry, '2026-10-11': entry, '2026-10-14': entry });
  assert.deepEqual(preview().map((r) => r.day), ['2026-10-11']);
});

test('nothing is reported when stats are empty or sharing is off', () => {
  write({});
  assert.deepEqual(preview(), []);
  write({ '2026-10-13': { 'hook:codex': { checked: 1, blocked: 0 } } });
  assert.deepEqual(share.pendingReports(NOW), []);
});

test('unknown agents, layers and type names are replaced, not passed on', () => {
  write({
    '2026-10-13': {
      'weird:my-private-agent': { checked: 1, blocked: 1, detections: { 'my_company_token': 2 } },
    },
  });
  const [r] = preview();
  assert.equal(r.agent, 'other');
  assert.equal(r.layer, 'cli');
  assert.deepEqual(r.detections, { OTHER: 2 });
});

test('the output holds no personal paths, home directory or file names', () => {
  write({
    '2026-10-13': {
      'hook:claude-code': {
        checked: 4, blocked: 1,
        detections: { aws_key: 1, '/home/alice/project/.env': 1, 'C:\\Users\\bob\\key.pem': 1 },
        path: '/home/alice/project', file: '/home/alice/project/.env', repo: 'example-repo',
      },
    },
  });
  const text = JSON.stringify(preview());
  assert.ok(text.includes('AWS_KEY'));
  for (const bad of ['/home/', 'alice', 'bob', 'C:\\', 'Users', '.env', '.pem', 'example-repo', home, os.homedir()]) {
    assert.equal(text.includes(bad), false, `output must not contain ${bad}`);
  }
});
