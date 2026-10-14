'use strict';
// zn-gate stats: local counts (lib/stats.js), the CLI (lib/stats-cli.js) and opt-in sharing (lib/stats-share.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-stats-test-'));
process.env.ZN_HOME = home;
delete process.env.ZN_STATS;
const stats = require('../lib/stats');
const share = require('../lib/stats-share');
const cli = require('../lib/stats-cli');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const reset = () => { for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { force: true }); };
const capture = async (args) => { let out = ''; const code = await cli.run(args, (s) => { out += s; }); return { code, out }; };

test('records counts per day, layer and agent; never content', () => {
  reset();
  const now = new Date('2026-10-14T10:00:00Z');
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, blocked: 1, detections: { aws_key: 1 } }, { now });
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 1, redacted: 2, detections: { 'GITHUB TOKEN': 2 } }, { now });
  stats.record({ layer: 'mcp', agent: 'mcp-client', checked: 1 }, { now });
  const data = JSON.parse(fs.readFileSync(stats.statsFile(), 'utf8'));
  assert.deepEqual(data.days['2026-10-14']['hook:claude-code'], { checked: 2, blocked: 1, warned: 0, redacted: 2, detections: { AWS_KEY: 1, GITHUB_TOKEN: 2 } });
  assert.equal((fs.statSync(stats.statsFile()).mode & 0o777).toString(8), '600');
  const s = stats.summary({ days: 30, now });
  assert.deepEqual(s.total, { checked: 3, blocked: 1, warned: 0, redacted: 2 });
  assert.deepEqual(s.detections, { AWS_KEY: 1, GITHUB_TOKEN: 2 });
});

test('names that do not fit become "other"; bad numbers are ignored; a corrupt file never throws', () => {
  reset();
  stats.record({ layer: 'weird', agent: '/home/me/secret project', checked: -5, blocked: 'x', detections: { '': 3, ok: Infinity } });
  const data = stats.load();
  const day = Object.values(data.days)[0];
  assert.deepEqual(Object.keys(day), ['cli:home-me-secret-project']);
  fs.writeFileSync(stats.statsFile(), '{not json');
  assert.doesNotThrow(() => stats.record({ layer: 'hook', agent: 'codex', checked: 1 }));
  assert.equal(stats.summary().total.checked, 1);
});

test('days older than 90 are dropped; ZN_STATS=off records nothing', () => {
  reset();
  stats.record({ layer: 'hook', agent: 'codex', checked: 1 }, { now: new Date('2026-06-01T00:00:00Z') });
  stats.record({ layer: 'hook', agent: 'codex', checked: 1 }, { now: new Date('2026-10-14T00:00:00Z') });
  assert.deepEqual(Object.keys(stats.load().days), ['2026-10-14']);
  process.env.ZN_STATS = 'off';
  try { stats.record({ layer: 'hook', agent: 'codex', checked: 5 }, { now: new Date('2026-10-14T00:00:00Z') }); } finally { delete process.env.ZN_STATS; }
  assert.equal(stats.load().days['2026-10-14']['hook:codex'].checked, 1);
});

test('the CLI shows the counts and says nothing is shared', async () => {
  reset();
  stats.record({ layer: 'hook', agent: 'cursor', checked: 4, blocked: 1, redacted: 3, detections: { AWS_KEY: 3 } });
  const { code, out } = await capture([]);
  assert.equal(code, 0);
  assert.match(out, /4 checks/);
  assert.match(out, /1 blocked/);
  assert.match(out, /3 secret values replaced/);
  assert.match(out, /AWS_KEY 3/);
  assert.match(out, /cursor \(agent hooks\)/);
  assert.match(out, /stay on this machine/);
  const json = JSON.parse((await capture(['--json'])).out);
  assert.equal(json.total.checked, 4);
  assert.equal(json.sharing, false);
});

test('sharing is off by default; reports hold only schema fields and only complete days after opting in', async () => {
  reset();
  assert.equal(share.status().share, false);
  assert.deepEqual(share.pendingReports(), []);
  const day = (d) => new Date(`2026-10-${d}T12:00:00Z`);
  stats.record({ layer: 'hook', agent: 'codex', checked: 1, detections: { AWS_KEY: 1 } }, { now: day(12) });
  share.setShare(true);
  // Opting in on the 14th does not send days before it.
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  cfg.stats.sent_until = '2026-10-13';
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  stats.record({ layer: 'hook', agent: 'codex', checked: 3, detections: { AWS_KEY: 2 } }, { now: day(13) });
  stats.record({ layer: 'mcp', agent: 'mcp-client', checked: 1, detections: { GITHUB_TOKEN: 1 } }, { now: day(13) });
  stats.record({ layer: 'hook', agent: 'codex', checked: 1 }, { now: day(14) });
  const reports = share.pendingReports(day(14));
  assert.equal(reports.length, 1, 'only the complete day after opting in');
  const r = reports[0];
  assert.deepEqual(Object.keys(r).sort(), ['agent', 'day', 'detections', 'install_id', 'layer', 'node_major', 'os', 'zn_gate_version'].sort());
  assert.equal(r.day, '2026-10-13');
  assert.equal(r.agent, 'codex');
  assert.equal(r.layer, 'hook');
  assert.deepEqual(r.detections, { AWS_KEY: 2, GITHUB_TOKEN: 1 });
  assert.match(r.install_id, /^[0-9a-f-]{36}$/);
  const id = r.install_id;
  share.setShare(false);
  assert.deepEqual(share.pendingReports(day(14)), []);
  share.setShare(true);
  assert.notEqual(share.status().install_id, id, 'a new random id each time sharing is turned on');
});

test('share subcommands explain what is sent', async () => {
  reset();
  assert.match((await capture(['share', 'status'])).out, /off \(the default\)/);
  const show = (await capture(['share', 'show'])).out;
  assert.match(show, /Never secret values, prompts, file names, paths/);
  assert.match((await capture(['share', 'on'])).out, /is on/);
  assert.match((await capture(['share', 'off'])).out, /Sharing is off/);
  assert.equal((await capture(['share', 'bogus'])).code, 2);
});
