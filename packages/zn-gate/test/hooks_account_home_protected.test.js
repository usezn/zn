'use strict';

process.env.ZN_STATS = 'off';

// The hook runner reads the settings that relax a check from the operating-system account's own .zn folder. That folder
// must be protected even when HOME (or USERPROFILE) names another folder, as in a container or a project's agent
// environment. Fake folders only; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const runner = require('../lib/hooks/runner');
const stats = require('../lib/stats');
const { tempDir } = require('./helpers/tmp');

/* An account home (what os.userInfo() would report) and a different HOME folder, restored after the test. */
function homes(t) {
  const account = tempDir(t, 'zn-account-');
  const envHome = tempDir(t, 'zn-envhome-');
  const before = process.env.ZN_HOME;
  delete process.env.ZN_HOME;
  stats._useRealHome(() => account);
  t.after(() => {
    stats._useRealHome(null);
    if (before !== undefined) process.env.ZN_HOME = before;
  });
  return { account, envHome };
}

test('accountHome is the folder that holds userHome', (t) => {
  const { account } = homes(t);
  assert.equal(stats.accountHome(), path.resolve(account));
  assert.equal(stats.userHome(), path.join(path.resolve(account), '.zn'));
});

test('the account .zn config file is protected when HOME names another folder', (t) => {
  const { account, envHome } = homes(t);
  const opts = { home: envHome, cwd: envHome, env: { HOME: envHome } };
  const cfg = path.join(account, '.zn', 'config.json');
  const c = policy.classifyPath(cfg, opts);
  assert.ok(c, 'expected a class for the account config file');
  assert.equal(c.kind, 'zn_state');
  // The folder the runner reads its settings from is that same folder.
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ hooks: { egressCheck: 'off' } }));
  process.env.ZN_HOME = path.join(account, '.zn');
  t.after(() => { delete process.env.ZN_HOME; });
  assert.equal(runner.readConfig().hooks.egressCheck, 'off');
  // The .zn under HOME stays protected too.
  assert.equal(policy.classifyPath(path.join(envHome, '.zn', 'config.json'), opts).kind, 'zn_state');
});

test('the agent plugin folders of the account home are protected when HOME names another folder', (t) => {
  const { account, envHome } = homes(t);
  const opts = { home: envHome, cwd: envHome, env: { HOME: envHome } };
  const c = policy.classifyPath(path.join(account, '.claude', 'plugins', 'x', 'hooks.json'), opts);
  assert.ok(c);
  assert.equal(c.kind, 'agent_config');
});

test('a file elsewhere in the account home is not classified by this rule', (t) => {
  const { account, envHome } = homes(t);
  const opts = { home: envHome, cwd: envHome, env: { HOME: envHome } };
  assert.equal(policy.classifyPath(path.join(account, 'notes', 'todo.txt'), opts), null);
});

test('without an account record only HOME is used', (t) => {
  const envHome = tempDir(t, 'zn-envhome-');
  stats._useRealHome(() => { throw new Error('no passwd entry'); });
  t.after(() => stats._useRealHome(null));
  assert.equal(stats.accountHome(), null);
  const opts = { home: envHome, cwd: envHome, env: { HOME: envHome } };
  assert.equal(policy.classifyPath(path.join(envHome, '.zn', 'vault'), opts).kind, 'zn_state');
});
