'use strict';

// The real command runner of the vault's Windows permissions (winacl.realTools().run), with child_process.spawnSync
// replaced so that it runs on every system. The logic with a stubbed runner is in vault_winacl.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const winacl = require('../lib/vault/winacl');

const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';

test('the real runner starts the file with its arguments, a SystemRoot, and the extra variables, and reports the status', (t) => {
  const seen = [];
  t.mock.method(cp, 'spawnSync', (file, args, opts) => {
    seen.push({ file, args, opts });
    return { status: 0, stdout: 'OUT', stderr: 'ERR' };
  });
  const r = winacl.realTools().run('C:\\Tools\\tool.exe', ['-Flag'], { ZN_ACL_PATH: 'C:\\vault' });
  assert.deepEqual(r, { status: 0, stdout: 'OUT', stderr: 'ERR', error: null });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, 'C:\\Tools\\tool.exe');
  assert.deepEqual(seen[0].args, ['-Flag']);
  assert.equal(seen[0].opts.timeout, 30000);
  assert.equal(seen[0].opts.env.SystemRoot, SYSTEM_ROOT);
  assert.equal(seen[0].opts.env.ZN_ACL_PATH, 'C:\\vault');
  assert.equal('PSModulePath' in seen[0].opts.env, false, 'only PowerShell gets a module path');
});

test('the runner adds the module path when the file is the system PowerShell', (t) => {
  const seen = [];
  t.mock.method(cp, 'spawnSync', (file, args, opts) => { seen.push(opts); return { status: 0, stdout: '' }; });
  winacl.realTools().run('powershell.exe', ['-Command', 'x'], undefined);
  assert.ok('PSModulePath' in seen[0].env, 'PowerShell is started with its module path');
});

test('a command that cannot be started gives empty output and the error, and no status', (t) => {
  const failure = Object.assign(new Error('spawn tool ENOENT'), { code: 'ENOENT' });
  t.mock.method(cp, 'spawnSync', () => ({ status: null, error: failure, stdout: null, stderr: null }));
  const r = winacl.realTools().run('missing-tool', [], {});
  assert.equal(r.status, null);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(r.error, failure);
});

test('the real tools name a PowerShell or nothing, never a guess from PATH', () => {
  const tools = winacl.realTools();
  assert.equal(typeof tools.run, 'function');
  assert.ok(tools.powershell === null || typeof tools.powershell === 'string');
});
