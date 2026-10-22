'use strict';
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { listAdapters, getAdapter } = require('../lib/agents');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', env: { ...process.env, ZN_STATS: 'off' } });
}

test('hooks usage lists every adapter, from the registry', () => {
  for (const args of [['hooks', 'install'], ['hooks', 'uninstall'], ['--help']]) {
    const r = run(args);
    const text = r.stderr + r.stdout;
    for (const id of listAdapters()) assert.ok(text.includes(id), args.join(' ') + ' usage misses ' + id);
    assert.ok(listAdapters().includes('gemini'));
  }
});

for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test('"' + name + '" is rejected as an unknown agent', () => {
    const r = run(['hooks', 'install', name]);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /unknown agent/);
    assert.throws(() => getAdapter(name), /unknown agent/);
  });
}

test('control and bidi characters in the agent id are not echoed', () => {
  const evil = 'x\u202Ey\u2066z\u001b[31mw\u0007';
  const r = run(['hooks', 'install', evil]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown agent "xyz\[31mw"/);
  assert.doesNotMatch(r.stderr, /[\u202E\u2066\u001b\u0007]/);
  assert.throws(() => getAdapter(evil), (e) => !/[\u202E\u2066\u001b\u0007]/.test(e.message) && /unknown agent "xyz\[31mw"/.test(e.message));
});
