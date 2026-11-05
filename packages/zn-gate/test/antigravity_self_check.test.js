'use strict';
process.env.ZN_STATS = 'off';
// selfCheck runs a hook command once with a harmless event: each outcome is ok or carries a plain detail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const agy = getAdapter('antigravity');
const skip = { skip: process.platform === 'win32' };

// Writes a fake hook script into a temporary folder and returns the command that runs it.
function fake(t, body) {
  const dir = tempDir(t, 'zn-agy-sc-');
  const file = path.join(dir, 'hook.js');
  fs.writeFileSync(file, body);
  return '"' + process.execPath + '" "' + file + '"';
}

test('selfCheck: a hook that prints an allow decision is ok', skip, (t) => {
  const r = agy.selfCheck(fake(t, "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'allow'})));"));
  assert.deepEqual(r, { ok: true, detail: 'it answered with a valid decision' });
});

test('selfCheck: a hook that prints nothing is not ok', skip, (t) => {
  const r = agy.selfCheck(fake(t, 'process.stdin.resume();process.stdin.on("end",()=>{});'));
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'it printed nothing');
});

test('selfCheck: a hook that prints text that is not JSON is not ok', skip, (t) => {
  const r = agy.selfCheck(fake(t, "console.log('hello, this is not json');"));
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'it answered with something that is not a decision');
});

test('selfCheck: a hook that answers deny is not ok and shows the reason', skip, (t) => {
  const r = agy.selfCheck(fake(t, "console.log(JSON.stringify({decision:'deny',reason:'blocked for the test'}));"));
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'it answered "deny" to a harmless event: blocked for the test');
});

test('selfCheck: a command that does not exist is not ok', skip, () => {
  const r = agy.selfCheck('zn-no-such-command-example-test');
  assert.equal(r.ok, false);
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.detail.length > 0);
});

test('selfCheck: a command that does not exist is reported as not found when split on spaces', skip, () => {
  const r = agy.selfCheck('zn-no-such-command-example-test --flag', { splitOnSpaces: true });
  assert.equal(r.ok, false);
  assert.match(r.detail, /could not be started \(zn-no-such-command-example-test was not found on the PATH\)/);
});

test('selfCheck: a hook that outlives the timeout is not ok', skip, (t) => {
  const started = Date.now();
  const r = agy.selfCheck(fake(t, 'setTimeout(()=>{}, 30000);'), { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'it did not answer within 20 seconds');
  assert.ok(Date.now() - started < 20000);
});
