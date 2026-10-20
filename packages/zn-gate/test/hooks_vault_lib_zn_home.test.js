'use strict';

// The agent may not load zn's vault client or daemon modules from a command, and a custom ZN_HOME is protected like
// ~/.zn. All commands here are text given to the policy; none is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../lib/hooks/policy');

const opts = { home: os.homedir(), cwd: process.cwd(), env: {} };
const denied = (cmd, o = opts) => policy.bashDenial(cmd, o);

const VAULT_LOADS = [
  `node -e "require('zn-gate/lib/vault/client').resolve('X')"`,
  `node -e "console.log(require('zn-gate/lib/vault/client').listSecrets())"`,
  `node -p "require('zn-gate/lib/vault/client').exactValues()"`,
  `node -e "require('/usr/lib/node_modules/zn-gate/lib/vault/client.js').resolve('A')"`,
  `node -e "require('/home/u/proj/node_modules/zn-gate/lib/vault/daemon').unlock()"`,
  `node -e "require('zn-gate/lib/vault/store')"`,
  `node -e "require('zn-gate@1.12.0/lib/vault/client')"`,
  `node -e "import('zn-gate/lib/vault/client').then(m => m.listSecrets())"`,
  `node --input-type=module -e "import c from 'zn-gate/lib/vault/client.js'; c.listSecrets()"`,
  `npx -y node -e "require('zn-gate/lib/vault/client')"`,
  `bun -e "import { resolve } from 'zn-gate/lib/vault/client'; resolve('K')"`,
  `bun -e "const c = await import('/x/node_modules/zn-gate/lib/vault/daemon.js'); c.serve()"`,
  `deno eval "import c from 'npm:zn-gate@1/lib/vault/client.js'; c.listSecrets()"`,
  `node -e "require('zn-gate' + '/lib/vault/' + 'client')"`,
  `node -e "require('zn-gate/lib/vault/cli' + 'ent')" ; node -e "require('zn-gate/lib/vault/client')"`,
  `node -e "require('zn-gate/lib\x2fvault/client')"`,
  `node -e "require(['zn-gate','lib','vault','client'].join('/'))"`,
  `node -e "require('ZN-GATE/LIB/VAULT/CLIENT')"`,
];

const ALLOWED = [
  `node -e "const z = require('zn-gate'); console.log(Object.keys(z))"`,
  `node -e "require('zn-gate').analyze('hello')"`,
  `npx -y zn-gate secret list`,
  `npx zn-gate vault status`,
  `zn-gate check`,
  `node --test test/vault_client.test.js`,
  `rg "listSecrets" packages/zn-gate/lib`,
  `git commit -m "Refactor lib/vault/client"`,
  `node -e "require('./my-own/client').resolve('x')"`,
];

test('loading the vault client, daemon or store from a command is refused', () => {
  for (const cmd of VAULT_LOADS) assert.ok(denied(cmd), 'allowed: ' + cmd);
});

test('the public API and the zn-gate commands stay allowed', () => {
  for (const cmd of ALLOWED) assert.equal(denied(cmd), null, 'refused: ' + cmd);
});

function withZnHome(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-home-test-'));
  const real = fs.realpathSync(root);
  const znHome = path.join(real, 'custom-zn');
  fs.mkdirSync(path.join(znHome, 'run'), { recursive: true });
  fs.mkdirSync(path.join(znHome, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(znHome, 'run', 'session.key'), 'fake');
  try { fn(real, znHome); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a custom ZN_HOME is protected like ~/.zn, by literal path and through $ZN_HOME', () => {
  withZnHome((root, znHome) => {
    const o = { home: os.homedir(), cwd: root, env: { ZN_HOME: znHome } };
    for (const cmd of [
      `cat ${znHome}/run/session.key`,
      `cat ${znHome}/vault/secrets.age`,
      `cat $ZN_HOME/run/session.key`,
      `cat \${ZN_HOME}/vault/store.json`,
      `ls ${znHome}/vault/`,
      `cp ${znHome}/vault/x /dev/null`,
    ]) assert.ok(denied(cmd, o), 'allowed: ' + cmd);
    assert.equal(denied(`cat ${root}/notes.txt`, o), null);
  });
});

test('a custom ZN_HOME reached through a symlink is protected', { skip: process.platform === 'win32' }, () => {
  withZnHome((root, znHome) => {
    const link = path.join(root, 'link-to-zn');
    fs.symlinkSync(znHome, link);
    const o = { home: os.homedir(), cwd: root, env: { ZN_HOME: link } };
    assert.ok(denied(`cat ${znHome}/run/session.key`, o), 'real path allowed');
    assert.ok(denied(`cat ${link}/run/session.key`, o), 'link path allowed');
  });
});

test('~/.zn stays protected when ZN_HOME is set elsewhere', () => {
  withZnHome((root, znHome) => {
    const o = { home: os.homedir(), cwd: root, env: { ZN_HOME: znHome } };
    assert.ok(denied('cat ~/.zn/run/session.key', o));
    assert.ok(denied(`cat ${os.homedir()}/.zn/vault/x`, o));
  });
});
