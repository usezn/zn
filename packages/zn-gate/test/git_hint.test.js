'use strict';

// The Claude Code plugin is downloaded with Git. On a machine without Git, init and check say so before the plugin
// steps (and how to get Git, and the route that needs none); with Git on PATH they print what they always printed.
// Git is simulated with a stub file on PATH: it is only looked up, never started.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { guide } = require('../lib/init-guide');
const { check, report } = require('../lib/check');
const gh = require('../lib/git-hint');
const { tempDir } = require('./helpers/tmp');
const { gitStubDir } = require('./helpers/git_stub');

const CLAUDE = path.resolve('/opt/bin/claude');

function machine(t, withGit) {
  const home = tempDir(t, 'zn-githint-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const bin = tempDir(t, 'zn-githint-bin-');
  // The folder is on PATH either way: with no Git it is an empty folder.
  return { home, env: { HOME: home, USERPROFILE: home, PATH: withGit ? gitStubDir(t) : bin }, cwd: tempDir(t, 'zn-githint-cwd-'), claude: CLAUDE, ancestry: () => null, temporary: false, nodeVersion: '22.0.0' };
}

async function init(m) {
  let text = '';
  const code = await guide({ ...m, stdin: { isTTY: false }, write: (x) => { text += x; }, run: () => true, confirm: async () => true });
  return { code, text };
}

test('gitMissing looks Git up on PATH only', (t) => {
  assert.equal(gh.gitMissing(machine(t, false).env), true);
  assert.equal(gh.gitMissing(machine(t, true).env), false);
});

test('init without Git: the first step is Git, before the plugin steps', async (t) => {
  const { code, text } = await init(machine(t, false));
  assert.equal(code, 1);
  assert.match(text, /install Git/);
  assert.match(text, /winget install --id Git\.Git -e/);
  assert.match(text, /git-scm\.com\/download\/win/);
  assert.match(text, /xcode-select --install/);
  assert.match(text, /package manager/);
  assert.match(text, /hooks install claude-code/);
  assert.match(text, /interactive terminal/);
  assert.match(text, /Plugin not found in marketplace/);
  assert.ok(text.indexOf('install Git') < text.indexOf('plugin marketplace add'), 'Git comes before the marketplace step');
});

test('init with Git: no Git note', async (t) => {
  const { text } = await init(machine(t, true));
  assert.doesNotMatch(text, /install Git/);
  assert.doesNotMatch(text, /Plugin not found in marketplace/);
  assert.match(text, /plugin marketplace add/);
});

test('check without Git: the fix of Claude Code starts with Git, JSON keeps its fields and adds git_missing', async (t) => {
  const m = machine(t, false);
  const out = await check({ home: m.home, env: m.env, cwd: m.cwd, live: false });
  const r = out.results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-set-up');
  assert.equal(r.gitMissing, true);
  assert.match(r.fix, /^first install Git/);
  assert.match(r.fix, /claude plugin marketplace add usezn\/zn#plugin-v/);
  assert.match(r.fix, /Plugin not found in marketplace/);
  assert.match(r.fix, /hooks install claude-code/);
  // Codex and the rest are untouched.
  assert.doesNotMatch(out.results.find((x) => x.id === 'codex').fix, /Git/);
});

test('check with Git: nothing added', async (t) => {
  const m = machine(t, true);
  const out = await check({ home: m.home, env: m.env, cwd: m.cwd, live: false });
  const r = out.results.find((x) => x.id === 'claude-code');
  assert.equal(r.gitMissing, undefined);
  assert.match(r.fix, /^install the zn-gate plugin/);
  assert.doesNotMatch(r.fix, /Git/);
});

test('check with Git: the text says to run init in plain words, and the JSON fix keeps the plugin steps', async (t) => {
  const m = machine(t, true);
  const out = await check({ home: m.home, env: m.env, cwd: m.cwd, live: false });
  let text = '';
  report(out, (x) => { text += x; });
  assert.match(text, /Claude Code\s+zn is not set up for this agent\. To protect it, run `npx -y zn-gate init` in your own terminal: it shows each step and asks before it runs one\./);
  assert.doesNotMatch(text, /plugin marketplace|stale|version: not found/);
  assert.match(out.results.find((x) => x.id === 'claude-code').fix, /claude plugin marketplace add usezn\/zn#plugin-v/);
});
