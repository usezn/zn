'use strict';

// A hook block written with an explicit home (check runs its live requests that way) goes to the ledger of
// ZN_HOME when it is set, like every other evidence write. Without ZN_HOME it stays in <home>/.zn.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '..', 'lib');

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-evidence-home-' + name + '-')); }

// Runs one blocked PreToolUse request in a child process with the given environment; returns the decision.
function blockWithHome(fakeHome, env) {
  const script = [
    "const runner=require(require('path').join(process.env.ZN_LIB,'hooks','runner'));",
    "const { getAdapter } = require(require('path').join(process.env.ZN_LIB,'agents'));",
    "const home=process.env.FAKE_HOME;",
    "const ev={session_id:'s',cwd:home,hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'cat ~/.aws/credentials'},tool_use_id:'t'};",
    "runner.handle(getAdapter('claude-code'), ev, { home }).then((r) => console.log(r.decision.decision));",
  ].join('');
  const base = { ...process.env };
  delete base.ZN_HOME;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...base, HOME: fakeHome, USERPROFILE: fakeHome, ZN_LIB: LIB, FAKE_HOME: fakeHome, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

test('a block with an explicit home writes its ledger under ZN_HOME, not under <home>/.zn', () => {
  const fakeHome = tmp('home');
  const znHome = tmp('znhome');
  assert.equal(blockWithHome(fakeHome, { ZN_HOME: znHome }), 'deny');
  assert.equal(lines(path.join(znHome, 'evidence.jsonl')).length, 1, 'the block is in the ZN_HOME ledger');
  assert.ok(!fs.existsSync(path.join(fakeHome, '.zn', 'evidence.jsonl')), 'nothing is written under the home folder');
});

test('without ZN_HOME a block with an explicit home stays in <home>/.zn', () => {
  const fakeHome = tmp('home');
  assert.equal(blockWithHome(fakeHome, {}), 'deny');
  assert.equal(lines(path.join(fakeHome, '.zn', 'evidence.jsonl')).length, 1);
});
