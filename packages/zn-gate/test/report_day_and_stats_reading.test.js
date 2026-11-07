'use strict';
// zn-gate report: the day arithmetic (dayMinus), the team check (inTeam) and the stats reading (readStats),
// checked through the public run() output with fake data in a temporary home.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-report-days-'));
process.env.ZN_HOME = home;
delete process.env.ZN_STATS;

const policy = require('../lib/team/policy');
const report = require('../lib/report');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const reset = () => { for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true }); };
const runAt = (now, args) => { let out = ''; const code = report.run(args, (s) => { out += s; }, { now: new Date(now) }); return { code, out }; };
const json = (now, args = []) => JSON.parse(runAt(now, ['--json', ...args]).out);
const writeStats = (days) => fs.writeFileSync(path.join(home, 'stats.json'), JSON.stringify({ days }));

test('dayMinus: a window that crosses a month boundary starts in the previous month', () => {
  reset();
  const j = json('2026-03-02T12:00:00Z', ['--since', '5d']);
  assert.equal(j.since, '2026-02-26');
  assert.equal(j.until, '2026-03-02');
});

test('dayMinus: a window over a leap day counts 29 February, and a normal year does not', () => {
  reset();
  assert.equal(json('2028-03-01T12:00:00Z', ['--since', '2d']).since, '2028-02-29');
  assert.equal(json('2028-03-01T12:00:00Z', ['--since', '3d']).since, '2028-02-28');
  assert.equal(json('2027-03-01T12:00:00Z', ['--since', '2d']).since, '2027-02-28');
});

test('dayMinus: a one-day window starts and ends on the same day, across a year boundary too', () => {
  reset();
  const j = json('2027-01-01T00:30:00Z', ['--since', '1d']);
  assert.equal(j.since, '2027-01-01');
  assert.equal(j.until, '2027-01-01');
  assert.equal(json('2027-01-01T00:30:00Z', ['--since', '2d']).since, '2026-12-31');
});

test('readStats: days at the edges of the window are included and days just outside are not', () => {
  reset();
  writeStats({
    '2028-02-27': { 'hook:claude-code': { blocked: 100 } },
    '2028-02-29': { 'hook:claude-code': { blocked: 2 } },
    '2028-03-01': { 'hook:claude-code': { blocked: 3 } },
    '2028-03-02': { 'hook:claude-code': { blocked: 400 } },
  });
  const j = json('2028-03-01T12:00:00Z', ['--since', '2d']);
  assert.equal(j.blocked, 5);
  assert.deepEqual(j.busiest_day, { day: '2028-03-01', blocked: 3 });
});

test('readStats: a day that is not a real calendar shape is ignored', () => {
  reset();
  writeStats({ '2026-3-1': { 'hook:x': { blocked: 7 } }, 'today': { 'hook:x': { blocked: 7 } }, '2026-03-01': { 'hook:x': { blocked: 1 } } });
  assert.equal(json('2026-03-01T12:00:00Z').blocked, 1);
});

test('inTeam: a valid team file hides the closing line, an invalid one does not', () => {
  reset();
  assert.match(runAt('2026-10-17T12:00:00Z', []).out, /usezn\.com\/team/);
  fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify({ v: 1, org: 'org_TestOrg12345678' }));
  assert.match(runAt('2026-10-17T12:00:00Z', []).out, /usezn\.com\/team/, 'a team entry without a key is not a team');
  const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const pin = { alg: 'Ed25519', kid: policy.kidOf(key), key };
  policy.writeTeam({ org: 'org_TestOrg12345678', policy_public_key: pin }, { home });
  assert.doesNotMatch(runAt('2026-10-17T12:00:00Z', []).out, /usezn\.com\/team/);
});

test('readStats: a missing stats file gives an empty report and exit code 0', () => {
  reset();
  const r = runAt('2026-10-17T12:00:00Z', []);
  assert.equal(r.code, 0);
  assert.match(r.out, /Nothing to report yet/);
  const j = json('2026-10-17T12:00:00Z');
  assert.equal(j.blocked, 0);
  assert.equal(j.busiest_day, null);
  assert.deepEqual(j.by_agent, {});
});

test('readStats: damaged stats files give an empty report and exit code 0', () => {
  const now = '2026-10-17T12:00:00Z';
  const cases = {
    'truncated JSON': '{"days": {"2026-10-17": {"hook:x": {"blocked": ',
    'empty file': '',
    'an array': '[]',
    'days is an array': '{"days": []}',
    'days is a string': '{"days": "2026-10-17"}',
    'null': 'null',
  };
  for (const [name, text] of Object.entries(cases)) {
    reset();
    fs.writeFileSync(path.join(home, 'stats.json'), text);
    const r = runAt(now, []);
    assert.equal(r.code, 0, name);
    assert.match(r.out, /Nothing to report yet/, name);
    assert.equal(json(now).blocked, 0, name);
  }
});

test('readStats: a directory in place of the stats file is treated as absent', () => {
  reset();
  fs.mkdirSync(path.join(home, 'stats.json'));
  const r = runAt('2026-10-17T12:00:00Z', []);
  assert.equal(r.code, 0);
  assert.match(r.out, /Nothing to report yet/);
});

test('readStats: damaged entries inside a good file are skipped without hiding the good ones', () => {
  reset();
  writeStats({
    '2026-10-17': {
      'hook:claude-code': { blocked: 4, redacted: 2, detections: { AWS_KEY: 1 } },
      'hook:broken': 'text',
      'other:claude-code': { blocked: 50 },
      'shield:cursor': { blocked: -3, checked: 'many' },
    },
    '2026-10-16': 'not an object',
  });
  const j = json('2026-10-17T12:00:00Z');
  assert.equal(j.blocked, 4);
  assert.equal(j.redacted, 2);
  assert.equal(j.secret_types.AWS_KEY, 1);
  assert.equal(j.secret_types.OTHER, 1);
  assert.deepEqual(j.busiest_day, { day: '2026-10-17', blocked: 4 });
});
