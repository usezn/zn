'use strict';
// zn-gate report: the closing Team line shows once outside a team, and never with the option off or inside a team.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-report-teamline-'));
process.env.ZN_HOME = home;
delete process.env.ZN_STATS;

const stats = require('../lib/stats');
const report = require('../lib/report');
const policy = require('../lib/team/policy');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const reset = () => { for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true }); };
const NOW = new Date('2026-10-17T12:00:00Z');
const run = (args) => { let out = ''; const code = report.run(args, (s) => { out += s; }, { now: NOW }); return { code, out }; };
const count = (s) => s.split(report.TEAM_LINE).length - 1;

function seed() {
  stats.record({ layer: 'hook', agent: 'cursor', checked: 5, blocked: 3, redacted: 2, detections: { AWS_KEY: 2 } }, { now: new Date('2026-10-15T10:00:00Z') });
}

function joinTeam() {
  const raw = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const kid = crypto.createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify({ v: 1, org: 'org_example1234', policy_public_key: { alg: 'Ed25519', kid, key: raw } }));
  assert.ok(policy.readTeam(), 'fixture should count as a team');
}

test('the Team line names usezn.com/team', () => {
  assert.match(report.TEAM_LINE, /usezn\.com\/team/);
});

test('with data, outside a team, the line is printed exactly once at the end', () => {
  reset(); seed();
  const { code, out } = run([]);
  assert.equal(code, 0);
  assert.equal(count(out), 1);
  assert.ok(out.endsWith(report.TEAM_LINE + '\n'));
});

test('with no data, outside a team, the line is printed exactly once', () => {
  reset();
  assert.equal(count(run([]).out), 1);
});

test('--no-team-line prints no line, with and without data', () => {
  reset();
  assert.equal(count(run(['--no-team-line']).out), 0);
  seed();
  assert.equal(count(run(['--no-team-line']).out), 0);
});

test('inside a team the line is not printed, with and without data', () => {
  reset(); joinTeam();
  assert.equal(count(run([]).out), 0);
  seed();
  const { out } = run([]);
  assert.equal(count(out), 0);
  assert.doesNotMatch(out, /usezn\.com\/team/);
});

test('the line comes back after leaving the team', () => {
  reset(); joinTeam();
  assert.equal(count(run([]).out), 0);
  fs.rmSync(path.join(home, 'team.json'));
  assert.equal(count(run([]).out), 1);
});
