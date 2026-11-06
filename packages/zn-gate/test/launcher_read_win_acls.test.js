'use strict';
process.env.ZN_STATS = 'off';
// readWinAcls with a fake PowerShell: a call that fails to start, one that exits non-zero, and one that succeeds with two entries.
const test = require('node:test');
const assert = require('node:assert/strict');
const launcher = require('../lib/agents/launcher');

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const SYSTEM = 'S-1-5-18';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const io = (reply, calls = []) => ({ powershell: PS, spawnSync: (file, args, o) => { calls.push({ file, args, o }); return reply; } });

test('readWinAcls: a PowerShell call that fails to start names the cause', () => {
  const reply = { error: new Error('spawn EACCES'), status: null, stdout: '', stderr: '' };
  assert.throws(() => launcher.readWinAcls(['C:\\a'], io(reply)), /could not read the access list of the folder \(spawn EACCES\)/);
});

test('readWinAcls: a non-zero exit names the error text, or the exit code when there is none', () => {
  assert.throws(() => launcher.readWinAcls(['C:\\a'], io({ status: 3, stdout: '', stderr: '  access denied for the folder \n' })), /\(access denied for the folder\)/);
  assert.throws(() => launcher.readWinAcls(['C:\\a'], io({ status: 5, stdout: '', stderr: '' })), /\(exit 5\)/);
});

test('readWinAcls: a successful call with two entries returns the parsed list', () => {
  const stdout = [
    'U\t' + ME,
    'E\t' + b64('C:\\a') + '\t' + ME + '\t1\t0',
    'A\t' + ME + '\t2032127\tAllow\t0\t3',
    'E\t' + b64('C:\\a\\b') + '\t' + SYSTEM + '\t1\t1',
    'A\t' + SYSTEM + '\t1179817\tDeny\t1\t0',
    'Z',
    '',
  ].join('\r\n');
  const calls = [];
  const res = launcher.readWinAcls(['C:\\a', 'C:\\a\\b'], io({ status: 0, stdout, stderr: '' }, calls));
  assert.equal(calls[0].o.env.ZN_ACL_PATHS, 'C:\\a|C:\\a\\b');
  assert.deepEqual(res, {
    user: ME,
    entries: [
      { path: 'C:\\a', owner: ME, dir: true, reparse: false, aces: [{ sid: ME, rights: 2032127, type: 'Allow', inheritOnly: false, inh: 3 }] },
      { path: 'C:\\a\\b', owner: SYSTEM, dir: true, reparse: true, aces: [{ sid: SYSTEM, rights: 1179817, type: 'Deny', inheritOnly: true, inh: 0 }] },
    ],
  });
});
