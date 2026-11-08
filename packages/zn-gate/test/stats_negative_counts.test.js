'use strict';
// lib/stats.js summary() over a stats file that holds negative counts. record() never writes a negative number,
// and the Python package counts a negative value as 0 when it reads the same file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-negative-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const file = path.join(home, 'negative.json');
const now = new Date('2026-11-08T12:00:00Z');

function summaryOf(days) {
  fs.writeFileSync(file, JSON.stringify({ version: 1, days, events: {} }));
  return stats.summary({ days: 30, now, file });
}

test('summary totals a file with positive counts only (baseline for the next test)', () => {
  const s = summaryOf({
    '2026-11-07': {
      'hook:codex': { checked: 5, blocked: 2, warned: 0, redacted: 1, detections: { AWS_KEY: 2 } },
    },
  });
  assert.deepEqual(s.total, { checked: 5, blocked: 2, warned: 0, redacted: 1 });
  assert.deepEqual(s.detections, { AWS_KEY: 2 });
});

test('summary ignores negative counts in a stats file', () => {
  const s = summaryOf({
    '2026-11-07': {
      'hook:codex': { checked: 5, blocked: 2, warned: 0, redacted: 1, detections: { AWS_KEY: 2 } },
      'shield:cursor': { checked: -3, blocked: -4, warned: 0, redacted: 0, detections: { AWS_KEY: -1, JWT: 1 } },
    },
  });
  assert.deepEqual(s.total, { checked: 5, blocked: 2, warned: 0, redacted: 1 });
  assert.deepEqual(s.detections, { AWS_KEY: 2, JWT: 1 });
});
