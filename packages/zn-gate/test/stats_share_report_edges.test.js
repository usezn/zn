'use strict';
// lib/stats-share.js: edge cases of the report built from a fixed stats object (preview mode, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-share-edges-'));
process.env.ZN_HOME = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const share = require('../lib/stats-share');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const NOW = new Date('2026-10-14T12:00:00Z');
const write = (days) => fs.writeFileSync(stats.statsFile(), JSON.stringify({ version: 1, days, events: {} }));
const preview = () => share.pendingReports(NOW, { preview: true });

test('the agent and layer come from the entry with the most checks', () => {
  write({
    '2026-10-13': {
      'hook:codex': { checked: 2, blocked: 0 },
      'shield:cursor': { checked: 9, blocked: 0 },
      'mcp:opencode': { checked: 4, blocked: 0 },
    },
  });
  const [r] = preview();
  assert.equal(r.layer, 'shield');
  assert.equal(r.agent, 'cursor');
});

test('fractional counts are rounded down and counts are capped at 100000000', () => {
  write({
    '2026-10-13': {
      'hook:codex': { checked: 1, blocked: 0, detections: { aws_key: 2.9, jwt: 5e12 } },
    },
  });
  const [r] = preview();
  assert.deepEqual(r.detections, { AWS_KEY: 2, JWT: 100000000 });
});

test('non-numeric counts are ignored', () => {
  write({
    '2026-10-13': {
      'hook:codex': { checked: 1, blocked: 0, detections: { aws_key: 'many', jwt: null, JWT_TOKEN: 3 } },
    },
  });
  const [r] = preview();
  assert.deepEqual(r.detections, { JWT: 3 });
});

test('the report holds the current node major version and a known os name', () => {
  write({ '2026-10-13': { 'hook:codex': { checked: 1, blocked: 0 } } });
  const [r] = preview();
  assert.equal(r.node_major, Number(process.versions.node.split('.')[0]));
  assert.ok(['linux', 'darwin', 'win32', 'other'].includes(r.os));
  assert.match(r.zn_gate_version, /^\d+\.\d+\.\d+/);
});

test('reports come out in day order', () => {
  const e = { 'hook:codex': { checked: 1, blocked: 0 } };
  write({ '2026-10-13': e, '2026-10-11': e, '2026-10-12': e });
  assert.deepEqual(preview().map((r) => r.day), ['2026-10-11', '2026-10-12', '2026-10-13']);
});
