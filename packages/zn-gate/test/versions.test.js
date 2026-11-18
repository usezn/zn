'use strict';

// zn-gate check shows the agent version found on the machine next to the version zn was last tested with.
// The agents here are fictional: shell scripts that print a version, in a temporary folder.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const V = require('../lib/agents/versions');
const { check, report } = require('../lib/check');

const POSIX = { skip: process.platform === 'win32' && 'the fake agents are #!/bin/sh scripts' };

function fakeBin(dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
}

function machine(t, bins) {
  const home = tempDir(t, 'zn-ver-home-');
  const bin = tempDir(t, 'zn-ver-bin-');
  const cwd = tempDir(t, 'zn-ver-cwd-');
  for (const [name, body] of Object.entries(bins)) fakeBin(bin, name, body);
  return { home, cwd, env: { HOME: home, USERPROFILE: home, PATH: bin + path.delimiter + '/usr/bin:/bin' } };
}

test('versions compare as numbers, not text', () => {
  assert.equal(V.compareVersions('0.170.0', '0.163.0'), 1);
  assert.equal(V.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(V.compareVersions('1.0.98', '1.0.98'), 0);
  assert.equal(V.compareVersions('0.9.0', '0.64.0'), -1);
  assert.equal(V.compareVersions('x', '1.0.0'), null);
});

test('the data file has an entry for every agent zn-gate supports', () => {
  const { AGENTS } = require('../lib/check');
  for (const a of AGENTS) assert.ok(Object.hasOwn(V.TESTED, a.id), a.id + ' is missing from tested-versions.json');
  for (const [id, e] of Object.entries(V.TESTED)) assert.ok(e.tested === null || /^\d+\.\d+\.\d+$/.test(e.tested), id);
});

test('a newer, equal and older agent each get their own plain sentence', POSIX, (t) => {
  const m = machine(t, { codex: 'echo "codex-cli 0.200.1"', opencode: 'echo 1.19.3', gemini: 'echo 0.1.0' });
  const o = { env: m.env, cwd: m.cwd };
  const newer = V.versionInfo('codex', o);
  assert.deepEqual([newer.found, newer.tested, newer.relation], ['0.200.1', '0.163.0', 'newer']);
  assert.match(V.versionLine(newer), /newer than 0\.163\.0.*may still work.*report it/i);
  assert.equal(V.versionInfo('opencode', o).relation, 'same');
  const older = V.versionInfo('gemini', o);
  assert.equal(older.relation, 'older');
  assert.match(V.versionLine(older), /older than 0\.64\.0/);
});

test('no program, a failing one, a silent one and a slow one all give "not found"', POSIX, (t) => {
  const m = machine(t, { codex: 'exit 3', opencode: 'echo hello', gemini: 'sleep 5; echo 9.9.9' });
  const o = { env: m.env, cwd: m.cwd, timeoutMs: 300 };
  for (const id of ['codex', 'opencode', 'gemini', 'copilot', 'cursor', 'zcode']) {
    const i = V.versionInfo(id, o);
    assert.equal(i.found, null, id);
    assert.match(V.versionLine(i), /^version: not found/);
  }
});

test('an agent with no tested version says so instead of comparing', POSIX, (t) => {
  const m = machine(t, { claude: 'echo "2.2.0 (Fake Code)"' });
  const i = V.versionInfo('claude-code', { env: m.env, cwd: m.cwd });
  assert.equal(i.relation, 'unknown');
  assert.match(V.versionLine(i), /2\.2\.0, no tested version recorded/);
});

test('--version runs with a bare environment and in an empty folder', POSIX, (t) => {
  const m = machine(t, { codex: 'if [ -n "$SECRET_TOKEN" ] || [ -f ./marker ]; then echo 9.9.9; else echo 0.163.0; fi' });
  fs.writeFileSync(path.join(m.cwd, 'marker'), '');
  const env = { ...m.env, SECRET_TOKEN: 'zn-fake-value-not-a-real-key' };
  assert.equal(V.versionInfo('codex', { env, cwd: m.cwd }).found, '0.163.0');
});

test('a program in the project folder is not run', POSIX, (t) => {
  const m = machine(t, {});
  fakeBin(m.cwd, 'codex', 'echo 9.9.9');
  const env = { ...m.env, PATH: m.cwd + path.delimiter + m.env.PATH };
  assert.equal(V.versionInfo('codex', { env, cwd: m.cwd }).found, null);
});

test('zn-gate check prints the version line under each agent found,', POSIX, async (t) => {
  const m = machine(t, { codex: 'echo 0.300.0' });
  fs.mkdirSync(path.join(m.home, '.codex'));
  const res = await check({ home: m.home, env: m.env, cwd: m.cwd });
  let out = '';
  report(res, (s) => { out += s; });
  assert.match(out, /Codex CLI[^\n]*\n\s+version 0\.300\.0, newer than 0\.163\.0/);
  assert.doesNotMatch(out, /Cursor\s+not found on this machine\n\s+version/);
});

test('a missing agent program is named in the report, with the hook note only under an OK agent', (t) => {
  const absent = { found: null, tested: null, relation: 'not-found', command: true, onPath: false };
  assert.equal(V.versionLine(absent, 'Claude Code', true), 'Claude Code program not found on PATH (hooks are installed; they run when the agent runs)');
  assert.equal(V.versionLine(absent, 'Claude Code'), 'Claude Code program not found on PATH');
  assert.equal(V.versionLine(absent), 'version: not found');
  assert.equal(V.versionLine({ found: null, tested: null, relation: 'not-found', command: true, onPath: true }, 'Claude Code'), 'Claude Code program on PATH printed no version');
  assert.equal(V.versionLine({ found: null, tested: null, relation: 'not-found', command: false, onPath: false }, 'Cursor', true), 'no version read: Cursor has no command that prints its version');
  const present = { found: '2.2.0', tested: null, relation: 'unknown' };
  assert.equal(V.versionLine(present, 'Claude Code', true), 'version 2.2.0, no tested version recorded');
});

test('report: an OK agent with no program on PATH says so instead of a bare "version: not found"', (t) => {
  const absent = { found: null, tested: null, relation: 'not-found', command: true, onPath: false };
  const results = [
    { id: 'claude-code', name: 'Claude Code', state: 'protected', message: 'zn: blocked', notes: [], version: absent },
    { id: 'codex', name: 'Codex CLI', state: 'not-set-up', fix: 'run zn hooks install codex', found: true, version: { found: null, tested: '0.163.0', relation: 'not-found', command: true, onPath: false } },
  ];
  let out = '';
  report({ results, removed: true, warnings: [] }, (s) => { out += s; });
  assert.match(out, /OK Claude Code +blocked the \.env file[^\n]*\n[^\n]*\n {5}Claude Code program not found on PATH \(hooks are installed; they run when the agent runs\)\n/);
  assert.doesNotMatch(out, /version: not found/);
  assert.match(out, /Codex CLI program not found on PATH\n/);
});

test('report: a present agent keeps its version line, and --json has no version field to change', (t) => {
  const results = [
    { id: 'claude-code', name: 'Claude Code', state: 'protected', message: 'zn: blocked', notes: [], version: { found: '2.2.0', tested: null, relation: 'unknown' } },
  ];
  let out = '';
  report({ results, removed: true, warnings: [] }, (s) => { out += s; });
  assert.match(out, /\n {5}version 2\.2\.0, no tested version recorded\n/);
  const { toJson } = require('../lib/check');
  const json = toJson({ results, removed: true, warnings: [] }, { home: '/nonexistent-zn-home' });
  assert.deepEqual(Object.keys(json.agents[0]).sort(), ['checked', 'fix', 'id', 'message', 'name', 'notes', 'protected', 'reason', 'state']);
});

test('versionInfo tells a missing program from one on PATH that printed nothing', POSIX, (t) => {
  const m = machine(t, { codex: 'exit 3' });
  const o = { env: m.env, cwd: m.cwd, timeoutMs: 300 };
  const absent = V.versionInfo('claude-code', o);
  assert.deepEqual([absent.relation, absent.command, absent.onPath], ['not-found', true, false]);
  assert.equal(V.versionLine(absent, 'Claude Code', true), 'Claude Code program not found on PATH (hooks are installed; they run when the agent runs)');
  const silent = V.versionInfo('codex', o);
  assert.deepEqual([silent.relation, silent.onPath], ['not-found', true]);
  assert.equal(V.versionInfo('cursor', o).command, false);
});
