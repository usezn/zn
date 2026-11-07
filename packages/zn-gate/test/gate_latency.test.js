'use strict';
/* Decision time per tool call: the percentile math, what is stored, and what `zn-gate doctor` prints. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const stats = require('../lib/stats');
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('percentile uses the nearest rank of a sorted list', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.strictEqual(stats.percentile(hundred, 50), 50);
  assert.strictEqual(stats.percentile(hundred, 95), 95);
  assert.strictEqual(stats.percentile(hundred, 100), 100);
  assert.strictEqual(stats.percentile([1, 2, 3, 4], 50), 2);
  assert.strictEqual(stats.percentile([1, 2, 3, 4], 95), 4);
  assert.strictEqual(stats.percentile([7], 50), 7);
  assert.strictEqual(stats.percentile([7], 95), 7);
  assert.strictEqual(stats.percentile([], 50), null);
});

test('latencySummary is null with no stored durations and over the last N otherwise', (t) => {
  const file = path.join(tempDir(t, 'zn-latency-'), 'stats.json');
  assert.strictEqual(stats.latencySummary({ file }), null);
  for (let i = 1; i <= 150; i++) stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, latencyMs: i }, { file, now: new Date('2026-11-06T10:00:00Z') });
  const s = stats.latencySummary({ file });
  assert.strictEqual(s.count, 100);
  // The last 100 durations are 51..150.
  assert.strictEqual(s.p50, 100);
  assert.strictEqual(s.p95, 145);
});

test('only durations are stored: no command, prompt or path, and bad values are dropped', (t) => {
  const file = path.join(tempDir(t, 'zn-latency-'), 'stats.json');
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, latencyMs: 2.345 }, { file });
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, latencyMs: NaN }, { file });
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, latencyMs: -3 }, { file });
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 1 }, { file });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(data.latency, { samples: [2.3] });
  assert.deepStrictEqual(Object.keys(data.latency), ['samples']);
});

test('no latency is stored for entries without latencyMs', (t) => {
  const file = path.join(tempDir(t, 'zn-latency-'), 'stats.json');
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 1 }, { file });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).latency, undefined);
});

test('ZN_STATS=off stores nothing', (t) => {
  const file = path.join(tempDir(t, 'zn-latency-'), 'stats.json');
  const before = process.env.ZN_STATS;
  process.env.ZN_STATS = 'off';
  try {
    stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, latencyMs: 3 }, { file });
  } finally {
    if (before === undefined) delete process.env.ZN_STATS; else process.env.ZN_STATS = before;
  }
  assert.strictEqual(fs.existsSync(file), false);
});

test('latencyReport says no data yet, shows measured p50 and p95, and says off', (t) => {
  const file = path.join(tempDir(t, 'zn-latency-'), 'stats.json');
  assert.strictEqual(stats.latencyReport({ file }), 'Decision time per tool call: no data yet. It is measured on each tool call your agent makes through zn.');
  assert.match(stats.latencyReport({ file, off: true }), /off \(ZN_STATS=off\)/);
  for (const ms of [1, 2, 3, 4, 10]) stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, latencyMs: ms }, { file });
  assert.strictEqual(stats.latencyReport({ file }), 'Decision time per tool call (last 5 calls, measured on this machine): p50 3.0 ms, p95 10.0 ms. Excludes process startup, writing the response, and saving stats and evidence.');
});

// `doctor` is the CLI command: it runs in a fresh home, so the file is the one the test writes.
function runDoctor(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: home };
  delete env.ZN_STATS;
  const r = spawnSync(process.execPath, [CLI, 'doctor'], { env, cwd: home, encoding: 'utf8', timeout: 60000 });
  return r.stdout;
}

test('zn-gate doctor prints "no data yet" when nothing was measured', (t) => {
  const home = tempDir(t, 'zn-doctor-latency-none-');
  assert.match(runDoctor(home), /Decision time per tool call: no data yet\./);
});

test('zn-gate doctor prints the measured p50 and p95 when there is data', (t) => {
  const home = tempDir(t, 'zn-doctor-latency-data-');
  const file = path.join(home, 'stats.json');
  for (const ms of [1, 2, 3, 4, 10]) stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, latencyMs: ms }, { file });
  const out = runDoctor(home);
  assert.match(out, /Decision time per tool call \(last 5 calls, measured on this machine\): p50 3\.0 ms, p95 10\.0 ms\. Excludes process startup/);
  assert.doesNotMatch(out, /no data yet/);
});
