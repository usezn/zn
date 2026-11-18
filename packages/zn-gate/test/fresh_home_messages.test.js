'use strict';
// A fresh home (no vault, no agent) and no terminal: the commands say what is missing, in plain words.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function freshHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-fresh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function run(home, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), PATH: path.dirname(process.execPath) };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE', 'CODEX_HOME', 'CURSOR_TRACE_ID', 'ZN_AGENT']) delete env[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input: '', encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('secret list on a fresh home says there is no vault yet, not that it is locked', (t) => {
  const home = freshHome(t);
  const r = run(home, ['secret', 'list']);
  assert.equal(r.code, 1);
  assert.match(r.out, /No vault yet\. Create one with .*secret set NAME, or run .*unlock to start\./);
  assert.doesNotMatch(r.out, /locked/);
});

test('secret list with an existing vault that is not running keeps the locked message', (t) => {
  const home = freshHome(t);
  fs.mkdirSync(path.join(home, '.zn', 'vault'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'vault', 'keychain.json'), '{}\n');
  const r = run(home, ['secret', 'list']);
  assert.equal(r.code, 1);
  assert.match(r.out, /Your secret vault is locked\. Unlock it in this terminal with: .*unlock/);
  assert.doesNotMatch(r.out, /No vault yet/);
});

test('init on a fresh home without a terminal names the agents and says it needs an interactive terminal', (t) => {
  const home = freshHome(t);
  const r = run(home, ['init']);
  assert.equal(r.code, 1);
  assert.match(r.out, /No supported coding agent was found \(Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app\)\. Nothing was changed\./);
  assert.match(r.out, /nothing to set up until one is installed/);
  assert.match(r.out, /in your own terminal \(init needs an interactive terminal, not a script or a pipe\)/);
});

test('init with an agent but without a terminal says hooks install needs a terminal too', (t) => {
  const home = freshHome(t);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const r = run(home, ['init']);
  assert.equal(r.code, 1);
  assert.match(r.out, /This is not an interactive terminal, so zn only prints the steps\. Nothing was changed\./);
  assert.match(r.out, /There is no non-interactive install: `zn hooks install` also needs an interactive terminal/);
});
