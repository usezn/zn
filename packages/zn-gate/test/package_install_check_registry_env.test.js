'use strict';

process.env.ZN_STATS = 'off';

// Package install check: a registry named inside the command itself (inline variables, env, scoped flags) means the
// names are never sent to the public registry. No network: the fetcher throws if it is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/package-check');
const reg = require('../lib/package-registry');

const regOf = (cmd) => pc.installsOf(cmd).map((i) => i.registry);

const PRIVATE = [
  'PIP_INDEX_URL=https://pypi.corp.example.invalid/simple pip install corp-billing-sdk',
  'PIP_EXTRA_INDEX_URL=https://pypi.corp.example.invalid/simple pip3 install corp-billing-sdk',
  'PIP_FIND_LINKS=https://files.example.invalid/ python -m pip install corp-billing-sdk',
  'PIP_CONFIG_FILE=/work/pip.conf pip install corp-billing-sdk',
  'UV_INDEX_URL=https://pypi.corp.example.invalid/simple uv add corp-billing-sdk',
  'UV_DEFAULT_INDEX=https://pypi.corp.example.invalid/simple uv pip install corp-billing-sdk',
  'UV_INDEX_CORP=https://pypi.corp.example.invalid/simple uv add corp-billing-sdk',
  'UV_CONFIG_FILE=/work/uv.toml uv add corp-billing-sdk',
  'npm_config_registry=https://npm.corp.example.invalid npm i corp-internal',
  'NPM_CONFIG_REGISTRY=https://npm.corp.example.invalid pnpm add corp-internal',
  'YARN_NPM_REGISTRY_SERVER=https://npm.corp.example.invalid yarn add corp-internal',
  'NPM_CONFIG_USERCONFIG=/work/npmrc npm i corp-internal',
  'env PIP_INDEX_URL=https://pypi.corp.example.invalid/simple pip install corp-billing-sdk',
  'sudo env PIP_INDEX_URL=https://pypi.corp.example.invalid/simple pip install corp-billing-sdk',
  'sudo -u build env npm_config_registry=https://npm.corp.example.invalid npm i corp-internal',
  'cd app && PIP_INDEX_URL=https://pypi.corp.example.invalid/simple pip install corp-billing-sdk',
  'PIP_INDEX_URL=https://pypi.corp.example.invalid/simple sh -c "pip install corp-billing-sdk"',
  'npm i --@corp:registry=https://npm.corp.example.invalid @corp/internal',
  'pnpm add --config.registry=https://npm.corp.example.invalid corp-internal',
  'npm i --userconfig /work/npmrc corp-internal',
  'uv add --config-file /work/uv.toml corp-billing-sdk',
];

for (const cmd of PRIVATE) {
  test('inline registry setting marks the install: ' + cmd, () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1, 'a name was read');
    assert.ok(r.every((x) => x === true), 'registry is true for every name');
  });
}

test('an empty or unrelated inline variable does not mark the install', () => {
  assert.deepEqual(regOf('PIP_INDEX_URL= pip install requests'), [false]);
  assert.deepEqual(regOf('FOO=bar pip install requests'), [false]);
  assert.deepEqual(regOf('env FOO=bar npm i lodash'), [false]);
  assert.deepEqual(regOf('PIP_INDEX_URL=https://pypi.corp.example.invalid/simple echo hi && pip install requests'), [false]);
});

test('online: a command with an inline registry variable sends no name to the public registry', async () => {
  const fetch = () => { throw new Error('the public registry must not be asked'); };
  for (const cmd of ['PIP_INDEX_URL=https://pypi.corp.example.invalid/simple pip install reqeusts-corp',
    'sudo env npm_config_registry=https://npm.corp.example.invalid npm i corp-internal']) {
    const lookup = (items) => reg.lookupMany(items, { fetch });
    const r = await pc.check(cmd, { mode: 'online', lookup });
    assert.deepEqual(r.unavailable, []);
    assert.ok(!r.findings.some((f) => f.kind === 'not_found'));
  }
});

test('uv value flags are not read as package names', () => {
  assert.deepEqual(pc.installsOf('uv add --project sub requests').map((i) => i.name), ['requests']);
  assert.deepEqual(pc.installsOf('uv pip install --index-strategy unsafe-best-match --python-platform linux requests').map((i) => i.name), ['requests']);
});
