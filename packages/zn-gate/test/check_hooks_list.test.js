'use strict';

// zn-gate check --hooks: every installed zn hook is listed with OK, STALE or BROKEN and the command that fixes it.
// It reads files only: nothing is written and no hook is run.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { listHooks, report } = require('../lib/hooks-list');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function setup(t, agents) {
  const home = tempDir(t, 'zn-hooks-list-home-');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH };
  for (const id of agents) {
    getAdapter(id).install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  }
  return { home, env, cwd: tempDir(t, 'zn-hooks-list-cwd-') };
}

const list = (s) => listHooks({ home: s.home, env: s.env, cwd: s.cwd });
const rowsOf = (res, id) => res.agents.filter((a) => a.id === id).flatMap((a) => a.files.flatMap((f) => f.rows));
const textOf = (res) => { let s = ''; const code = report(res, (x) => { s += x; }); return { s, code }; };
const launcherPath = (home, id) => path.join(home, '.zn', 'hooks', 'zn-hook-' + id + '.sh');

test('no agent set up: nothing listed, exit 0', (t) => {
  const s = setup(t, []);
  const { s: out, code } = textOf(list(s));
  assert.equal(code, 0);
  assert.match(out, /None found/);
});

test('a fresh install is all OK, and every event is listed with its command', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t, ['claude-code', 'codex', 'cursor']);
  const res = list(s);
  for (const id of ['claude-code', 'codex', 'cursor']) {
    const rows = rowsOf(res, id);
    assert.ok(rows.length > 0, id);
    assert.ok(rows.every((r) => r.status === 'OK'), id + ': ' + JSON.stringify(rows.filter((r) => r.status !== 'OK')));
  }
  const { s: out, code } = textOf(res);
  assert.equal(code, 0);
  assert.match(out, /Claude Code \(user\): .*settings\.json/);
  assert.match(out, /PreToolUse/);
  assert.match(out, /zn-hook-codex\.sh/);
  assert.match(out, / 0 stale, 0 broken\./);
});

test('a launcher the current zn-gate would write differently is STALE', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t, ['codex']);
  const f = launcherPath(s.home, 'codex');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '# an older launcher had other text here\n');
  const rows = rowsOf(list(s), 'codex');
  assert.ok(rows.length > 0 && rows.every((r) => r.status === 'STALE'));
  const { s: out, code } = textOf(list(s));
  assert.equal(code, 1);
  assert.match(out, /Fix: run `zn hooks install codex`/);
});

test('a launcher that did not record the package files (older zn-gate) is STALE', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t, ['codex']);
  const f = launcherPath(s.home, 'codex');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^ZN_FILES=.*\n/m, ''));
  const rows = rowsOf(list(s), 'codex');
  assert.ok(rows.length > 0 && rows.every((r) => r.status === 'STALE'), JSON.stringify(rows));
});

test('a missing launcher file, or a missing Node.js, is BROKEN', { skip: process.platform === 'win32' }, (t) => {
  const a = setup(t, ['codex']);
  fs.unlinkSync(launcherPath(a.home, 'codex'));
  const rowsA = rowsOf(list(a), 'codex');
  assert.ok(rowsA.length > 0 && rowsA.every((r) => r.status === 'BROKEN'));
  assert.match(textOf(list(a)).s, /Fix: run `zn hooks install codex`/);

  const b = setup(t, ['codex']);
  const f = launcherPath(b.home, 'codex');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^ZN_NODE='.*'$/m, "ZN_NODE='/nonexistent/zn-test/node'"));
  const rowsB = rowsOf(list(b), 'codex');
  assert.ok(rowsB.length > 0 && rowsB.every((r) => r.status === 'BROKEN'));
  assert.match(rowsB[0].reason, /Node\.js/);
});

test('the same hook written twice for an event is BROKEN (duplicate)', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t, ['cursor']);
  const file = path.join(s.home, '.cursor', 'hooks.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const event = Object.keys(data.hooks)[0];
  data.hooks[event].push({ ...data.hooks[event][0] });
  fs.writeFileSync(file, JSON.stringify(data));
  const dup = rowsOf(list(s), 'cursor').filter((r) => r.event === event);
  assert.equal(dup.length, 2);
  assert.ok(dup.every((r) => r.status === 'BROKEN' && /times/.test(r.reason)));
});

test('a config file that is not valid JSON is BROKEN; a zn-looking entry in a wrong form is BROKEN', (t) => {
  const s = setup(t, []);
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex', 'hooks.json'), '{ "hooks": ');
  const rows = rowsOf(list(s), 'codex');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'BROKEN');
  assert.match(rows[0].reason, /not valid JSON/);

  fs.mkdirSync(path.join(s.home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeReadFile: [{ command: '/odd path/zn-hook-cursor.sh beforeReadFile' }] } }));
  const c = rowsOf(list(s), 'cursor');
  assert.equal(c.length, 1);
  assert.equal(c[0].status, 'BROKEN');
  assert.match(c[0].reason, /exact form/);
});

test('hooks that are not zn\'s are not listed', (t) => {
  const s = setup(t, []);
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  assert.equal(list(s).agents.length, 0);
});

test('it never changes a file', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t, ['claude-code', 'codex']);
  const snap = () => {
    const out = {};
    const walk = (d) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        const st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8') + '|' + st.mtimeMs;
      }
    };
    walk(s.home);
    return out;
  };
  const before = snap();
  list(s);
  assert.deepEqual(snap(), before);
});

test('zn-gate check --hooks (and doctor --hooks) prints the list and exits 1 when something is wrong', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t, ['codex']);
  const env = { ...s.env, ZN_STATS: 'off' };
  const ok = spawnSync(process.execPath, [CLI, 'check', '--hooks'], { cwd: s.cwd, env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /zn hooks installed on this machine/);
  assert.doesNotMatch(ok.stdout, /test folder/);
  fs.unlinkSync(launcherPath(s.home, 'codex'));
  const bad = spawnSync(process.execPath, [CLI, 'doctor', '--hooks'], { cwd: s.cwd, env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /BROKEN/);
  assert.match(bad.stdout, /zn hooks install codex/);
});
