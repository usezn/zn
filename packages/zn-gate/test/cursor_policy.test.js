'use strict';

// Cursor's enterprise hooks.json: zn reads it (never writes) and says when zn's hook there is not set to fail closed.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cursorPolicyWarnings, _internal } = require('../lib/agents/managed-policy');
const { tempDir } = require('./helpers/tmp');

const ZN = 'zn hook cursor';
const hooks = (o) => JSON.stringify({ version: 1, hooks: o });
const full = hooks({
  beforeReadFile: [{ command: ZN, failClosed: true }],
  beforeSubmitPrompt: [{ command: ZN, failClosed: true }],
  beforeShellExecution: [{ command: ZN }],
});

function file(t, text) {
  const f = path.join(tempDir(t, 'zn-cursor-policy-'), 'hooks.json');
  if (text !== undefined) fs.writeFileSync(f, text);
  return { hooksFile: f };
}

test('system paths per OS (nothing is read)', () => {
  assert.equal(_internal.cursorEnterpriseFile('linux', {}), '/etc/cursor/hooks.json');
  assert.equal(_internal.cursorEnterpriseFile('darwin', {}), '/Library/Application Support/Cursor/hooks.json');
  assert.equal(_internal.cursorEnterpriseFile('win32', {}), path.join('C:\\ProgramData', 'Cursor', 'hooks.json'));
  assert.equal(_internal.cursorEnterpriseFile('win32', { ProgramData: 'D:\\PD' }), path.join('D:\\PD', 'Cursor', 'hooks.json'));
});

test('no file: no warning', (t) => {
  const root = tempDir(t, 'zn-cursor-root-');
  assert.deepEqual(cursorPolicyWarnings({ hooksFile: path.join(root, 'hooks.json') }), []);
  assert.deepEqual(cursorPolicyWarnings({ platform: 'win32', env: { ProgramData: root } }), []);
});

test('the enterprise file is read from the ProgramData folder on Windows', (t) => {
  const root = tempDir(t, 'zn-cursor-pd-');
  fs.mkdirSync(path.join(root, 'Cursor'));
  fs.writeFileSync(path.join(root, 'Cursor', 'hooks.json'), hooks({ beforeReadFile: [{ command: ZN }] }));
  const w = cursorPolicyWarnings({ platform: 'win32', env: { ProgramData: root } });
  assert.equal(w.length, 2);
  assert.ok(w[0].includes(path.join(root, 'Cursor', 'hooks.json')));
});

test('zn hook with failClosed on both events: no warning', (t) => {
  assert.deepEqual(cursorPolicyWarnings(file(t, full)), []);
});

test('zn hook without failClosed: one warning per event, with file and key', (t) => {
  const o = file(t, hooks({ beforeReadFile: [{ command: ZN }], beforeSubmitPrompt: [{ command: ZN, failClosed: false }] }));
  const w = cursorPolicyWarnings(o);
  assert.equal(w.length, 2);
  assert.ok(w[0].includes(o.hooksFile) && w[0].includes('hooks.beforeReadFile') && w[0].includes('"failClosed": true'));
  assert.ok(w[1].includes('hooks.beforeSubmitPrompt') && w[1].includes('prompt through'));
});

test('zn hook on one event only: the other event is reported', (t) => {
  const w = cursorPolicyWarnings(file(t, hooks({ beforeReadFile: [{ command: ZN, failClosed: true }] })));
  assert.equal(w.length, 1);
  assert.match(w[0], /hooks\.beforeSubmitPrompt/);
});

test('the zn command may be the runner path', (t) => {
  const cmd = 'node "/opt/zn-gate/lib/hooks/runner.js" cursor';
  assert.deepEqual(cursorPolicyWarnings(file(t, hooks({
    beforeReadFile: [{ command: cmd, failClosed: true }],
    beforeSubmitPrompt: [{ command: cmd, failClosed: true }],
  }))), []);
});

test('enterprise hooks without zn: says they do not switch zn off', (t) => {
  const w = cursorPolicyWarnings(file(t, hooks({ beforeShellExecution: [{ command: '/opt/corp/audit.sh', failClosed: true }] })));
  assert.equal(w.length, 1);
  assert.match(w[0], /do not include zn's hook/);
  assert.match(w[0], /do not turn off the zn hooks you install/);
});

test('empty hooks or an empty file: nothing to say', (t) => {
  assert.deepEqual(cursorPolicyWarnings(file(t, hooks({}))), []);
  assert.deepEqual(cursorPolicyWarnings(file(t, '')), []);
});

test('invalid file: "could not read", never a throw', (t) => {
  const bad = cursorPolicyWarnings(file(t, '{ nope'));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^could not read the Cursor enterprise hooks .* \(invalid JSON\)/);
  const o = file(t);
  fs.mkdirSync(o.hooksFile);
  assert.match(cursorPolicyWarnings(o)[0], /^could not read/);
});

test('read-only: the file is not changed', (t) => {
  const o = file(t, hooks({ beforeReadFile: [{ command: ZN }] }));
  const before = fs.readFileSync(o.hooksFile, 'utf8');
  cursorPolicyWarnings(o);
  assert.equal(fs.readFileSync(o.hooksFile, 'utf8'), before);
});
