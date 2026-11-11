'use strict';

// The stats of a hook block go to the ZN_HOME folder when it is set, like the evidence ledger. Without ZN_HOME
// they stay in <home>/.zn, the folder of the home that the check passes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '..', 'lib');

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-home-' + name + '-')); }

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
  delete base.ZN_STATS;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...base, HOME: fakeHome, USERPROFILE: fakeHome, ZN_LIB: LIB, FAKE_HOME: fakeHome, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// The number of hook checks counted in a stats file (0 when the file does not exist).
function hookChecks(file) {
  if (!fs.existsSync(file)) return 0;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (const day of Object.values(data.days || {})) {
    for (const [key, c] of Object.entries(day)) if (key.startsWith('hook:')) n += c.checked;
  }
  return n;
}

test('a block with an explicit home counts its stats under ZN_HOME, not under <home>/.zn', () => {
  const fakeHome = tmp('home');
  const znHome = tmp('znhome');
  assert.equal(blockWithHome(fakeHome, { ZN_HOME: znHome }), 'deny');
  assert.equal(hookChecks(path.join(znHome, 'stats.json')), 1, 'the check is counted in the ZN_HOME stats');
  assert.ok(!fs.existsSync(path.join(fakeHome, '.zn', 'stats.json')), 'no stats file under the home folder');
});

test('without ZN_HOME a block with an explicit home counts its stats in <home>/.zn', () => {
  const fakeHome = tmp('home');
  assert.equal(blockWithHome(fakeHome, {}), 'deny');
  assert.equal(hookChecks(path.join(fakeHome, '.zn', 'stats.json')), 1);
});
