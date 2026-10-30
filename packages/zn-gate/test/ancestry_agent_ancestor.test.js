'use strict';

// agentAncestor with an explicit pid and platform, on a machine where the process table cannot be read:
// the answer is null and nothing throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');
const exe = require('../lib/exe');

const ANCESTRY = require.resolve('../lib/broker/ancestry');

/* Loads a fresh copy of the module while `patch` is active, then restores everything. */
function withFresh(patch, fn) {
  const saved = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, spawnSync: childProcess.spawnSync, systemPowerShell: exe.systemPowerShell };
  const cached = require.cache[ANCESTRY];
  delete require.cache[ANCESTRY];
  try {
    const load = () => require(ANCESTRY).agentAncestor;
    patch(load);
    return fn(load());
  } finally {
    fs.existsSync = saved.existsSync;
    fs.readFileSync = saved.readFileSync;
    childProcess.spawnSync = saved.spawnSync;
    exe.systemPowerShell = saved.systemPowerShell;
    delete require.cache[ANCESTRY];
    if (cached) require.cache[ANCESTRY] = cached;
  }
}

const noFiles = () => {
  fs.existsSync = () => false;
};

test('agentAncestor: linux without /proc and without ps gives null', () => {
  withFresh(() => {
    noFiles();
    childProcess.spawnSync = () => { throw new Error('must not run'); };
  }, (agentAncestor) => {
    assert.equal(agentAncestor({ pid: 4242, platform: 'linux' }), null);
  });
});

test('agentAncestor: darwin where ps fails or cannot start gives null', () => {
  for (const result of [{ status: 1, stdout: '' }, { error: new Error('spawn failed'), status: null, stdout: '' }]) {
    withFresh(() => {
      fs.existsSync = (p) => String(p).endsWith('/ps');
      childProcess.spawnSync = () => result;
    }, (agentAncestor) => {
      assert.equal(agentAncestor({ pid: 4242, platform: 'darwin' }), null);
    });
  }
});

test('agentAncestor: darwin where ps throws gives null', () => {
  withFresh(() => {
    fs.existsSync = () => true;
    childProcess.spawnSync = () => { throw new Error('boom'); };
  }, (agentAncestor) => {
    assert.equal(agentAncestor({ pid: 4242, platform: 'darwin' }), null);
  });
});

test('agentAncestor: win32 without a system PowerShell gives null', () => {
  withFresh(() => {
    noFiles();
    exe.systemPowerShell = () => null;
    childProcess.spawnSync = () => { throw new Error('must not run'); };
  }, (agentAncestor) => {
    assert.equal(agentAncestor({ pid: 4242, platform: 'win32' }), null);
  });
});

test('agentAncestor: win32 where the query fails or throws gives null', () => {
  const failures = [() => ({ status: 1, stdout: '' }), () => ({ error: new Error('timed out'), status: null, stdout: '' }), () => { throw new Error('boom'); }];
  for (const fail of failures) {
    withFresh(() => {
      exe.systemPowerShell = () => 'C:\\Example\\powershell.exe';
      childProcess.spawnSync = fail;
    }, (agentAncestor) => {
      assert.equal(agentAncestor({ pid: 4242, platform: 'win32' }), null);
    });
  }
});
