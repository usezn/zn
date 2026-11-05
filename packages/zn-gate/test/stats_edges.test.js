'use strict';
// lib/stats.js edge cases: today(), known(), normType(), load(), record(), recordEvent() and summary() boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-edges-test-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const file = path.join(home, 'edges.json');
const reset = () => fs.rmSync(file, { force: true });
const at = (s) => new Date(`${s}T12:00:00Z`);

test('today uses the UTC date', () => {
  assert.equal(stats.today(new Date('2026-03-01T23:59:59Z')), '2026-03-01');
  assert.equal(stats.today(new Date('2026-03-02T00:00:00Z')), '2026-03-02');
});

test('known includes the built-in names and never an empty name', () => {
  const k = stats.known();
  for (const t of ['DB_PASSWORD', 'CREDENTIAL', 'SECRET', 'ENV_VALUE', 'OTHER']) assert.ok(k.has(t), t);
  assert.ok(!k.has(''));
});

test('normType maps empty, missing and unknown input to OTHER', () => {
  for (const v of [undefined, null, '', '   ', '!!!', 'MY_COMPANY_TOKEN', 42, {}]) assert.equal(stats.normType(v), 'OTHER', String(v));
});

test('normType normalizes case and separators, and maps aliases and ENV_ names', () => {
  assert.equal(stats.normType('aws-access-key'), 'AWS_KEY');
  assert.equal(stats.normType('  jwt_token '), 'JWT');
  assert.equal(stats.normType('db url password'), 'DB_PASSWORD');
  assert.equal(stats.normType('env_my_private_name'), 'ENV_VALUE');
  assert.equal(stats.normType('secret'), 'SECRET');
});

test('normType cuts very long names, which then are not known', () => {
  assert.equal(stats.normType('A'.repeat(500)), 'OTHER');
});

test('load returns an empty structure for bad file contents', () => {
  for (const body of ['', 'null', '[]', '"text"', '123', '{"days":"x"}', '{not json']) {
    fs.writeFileSync(file, body);
    const d = stats.load(file);
    assert.deepEqual(d, { version: 1, days: {}, events: {} }, JSON.stringify(body));
  }
  assert.deepEqual(stats.load(path.join(home, 'missing.json')), { version: 1, days: {}, events: {} });
});

test('load adds an events object when it is missing or invalid', () => {
  fs.writeFileSync(file, JSON.stringify({ version: 1, days: {}, events: null }));
  assert.deepEqual(stats.load(file).events, {});
  fs.writeFileSync(file, JSON.stringify({ version: 1, days: {} }));
  assert.deepEqual(stats.load(file).events, {});
});

test('record ignores a missing entry and creates no file', () => {
  reset();
  stats.record(null, { file });
  stats.record(undefined, { file });
  assert.equal(fs.existsSync(file), false);
});

test('record with an unknown layer counts under cli and an empty agent under other', () => {
  reset();
  stats.record({ layer: 'bogus', checked: 1 }, { file, now: at('2026-03-01') });
  assert.deepEqual(Object.keys(stats.load(file).days['2026-03-01']), ['cli:other']);
});

test('record floors fractions and drops zero, negative, NaN and infinite counts', () => {
  reset();
  stats.record({
    layer: 'hook', agent: 'a', checked: 2.9, blocked: -1, warned: NaN, redacted: Infinity,
    detections: { AWS_KEY: 1.5, GITHUB_TOKEN: 0, SECRET: -3, JWT: 'x', DB_PASSWORD: '2' },
  }, { file, now: at('2026-03-01') });
  const c = stats.load(file).days['2026-03-01']['hook:a'];
  assert.equal(c.checked, 2);
  assert.equal(c.blocked, 0);
  assert.equal(c.warned, 0);
  assert.equal(c.redacted, 0);
  assert.deepEqual(c.detections, { AWS_KEY: 1, DB_PASSWORD: 2 });
});

test('record merges detection names that normalize to the same type', () => {
  reset();
  stats.record({ layer: 'mcp', agent: 'a', detections: { AWS_ACCESS_KEY: 1, aws_key: 2, 'my own name': 1, 'other thing': 1 } }, { file, now: at('2026-03-01') });
  assert.deepEqual(stats.load(file).days['2026-03-01']['mcp:a'].detections, { AWS_KEY: 3, OTHER: 2 });
});

test('record never throws when the target cannot be written', () => {
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => stats.record({ layer: 'hook', checked: 1 }, { file: path.join(blocker, 'sub', 's.json') }));
  assert.equal(fs.readdirSync(home).some((f) => f.endsWith('.tmp')), false);
});

test('record keeps a day exactly 90 days old and drops the day before it', () => {
  reset();
  const now = at('2026-06-01');
  const cutoff = stats.today(new Date(now.getTime() - stats.KEEP_DAYS * 86400000));
  const before = stats.today(new Date(now.getTime() - (stats.KEEP_DAYS + 1) * 86400000));
  fs.writeFileSync(file, JSON.stringify({ version: 1, events: {}, days: { [cutoff]: { 'cli:a': { checked: 1 } }, [before]: { 'cli:a': { checked: 1 } } } }));
  stats.record({ checked: 1 }, { file, now });
  const days = Object.keys(stats.load(file).days);
  assert.ok(days.includes(cutoff));
  assert.ok(!days.includes(before));
});

test('record leaves no temporary files and gives the file mode 0600', { skip: process.platform === 'win32' }, () => {
  reset();
  stats.record({ checked: 1 }, { file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('ZN_STATS=off, in any case, stops record and recordEvent', () => {
  reset();
  for (const v of ['off', 'OFF', 'Off']) {
    process.env.ZN_STATS = v;
    assert.equal(stats.enabled(), false);
    stats.record({ checked: 1 }, { file });
    stats.recordEvent('x', { file });
  }
  delete process.env.ZN_STATS;
  assert.equal(fs.existsSync(file), false);
  process.env.ZN_STATS = 'on';
  assert.equal(stats.enabled(), true);
  delete process.env.ZN_STATS;
});

test('recordEvent counts per normalized name, and bad names go to other', () => {
  reset();
  stats.recordEvent('Planned Feature', { file });
  stats.recordEvent('planned-feature', { file });
  stats.recordEvent('', { file });
  stats.recordEvent(undefined, { file });
  assert.deepEqual(stats.load(file).events, { 'planned-feature': 2, other: 2 });
});

test('summary of a missing file is all zeros with no first day', () => {
  const s = stats.summary({ file: path.join(home, 'nope.json'), now: at('2026-03-01') });
  assert.equal(s.days, 30);
  assert.equal(s.since, null);
  assert.deepEqual(s.total, { checked: 0, blocked: 0, warned: 0, redacted: 0 });
  assert.deepEqual(s.byKey, {});
  assert.deepEqual(s.detections, {});
  assert.deepEqual(s.events, {});
});

test('summary window: days=1 is today only and the boundary day is included', () => {
  reset();
  const d = (n, c) => ({ 'cli:a': { checked: c, detections: { SECRET: c } } });
  fs.writeFileSync(file, JSON.stringify({ version: 1, events: { e: 1 }, days: { '2026-03-01': d(0, 1), '2026-02-28': d(0, 10), '2026-02-27': d(0, 100) } }));
  const now = at('2026-03-01');
  const one = stats.summary({ days: 1, now, file });
  assert.equal(one.total.checked, 1);
  assert.equal(one.since, '2026-03-01');
  const three = stats.summary({ days: 3, now, file });
  assert.equal(three.total.checked, 111);
  assert.equal(three.since, '2026-02-27');
  assert.equal(three.detections.SECRET, 111);
  assert.deepEqual(three.events, { e: 1 });
});

test('summary tolerates entries with missing fields and returns a copy of events', () => {
  reset();
  fs.writeFileSync(file, JSON.stringify({ version: 1, events: { e: 1 }, days: { '2026-03-01': { 'cli:a': {}, 'hook:b': { blocked: 2 } } } }));
  const s = stats.summary({ now: at('2026-03-01'), file });
  assert.deepEqual(s.total, { checked: 0, blocked: 2, warned: 0, redacted: 0 });
  assert.deepEqual(Object.keys(s.byKey).sort(), ['cli:a', 'hook:b']);
  s.events.e = 99;
  assert.equal(stats.load(file).events.e, 1);
});
