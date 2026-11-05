'use strict';

process.env.ZN_STATS = 'off';

// Package install check: a registry or index set elsewhere in the same command line (export, a bare assignment,
// a config set) makes every install in that line private. No network: the fetcher throws if it is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/package-check');
const reg = require('../lib/package-registry');

const P = 'https://pypi.corp.example.invalid/simple';
const N = 'https://npm.corp.example.invalid';
const regOf = (cmd) => pc.installsOf(cmd).map((i) => i.registry);

const PRIVATE = [
  // (a) an assignment in an earlier segment
  `export PIP_INDEX_URL=${P} && pip install corp-billing-sdk`,
  `export PIP_INDEX_URL=${P}; pip install corp-billing-sdk`,
  `export PIP_INDEX_URL=${P} || pip install corp-billing-sdk`,
  `export NPM_CONFIG_REGISTRY=${N} && npm i corp-internal`,
  `PIP_INDEX_URL=${P}; pip install corp-billing-sdk`,
  `PIP_INDEX_URL=${P}\npip install corp-billing-sdk`,
  `declare -x PIP_INDEX_URL=${P} && pip install corp-billing-sdk`,
  `export FOO=1 PIP_INDEX_URL=${P} && sudo pip install corp-billing-sdk`,
  `export PIP_INDEX_URL=${P} && sh -c "pip install corp-billing-sdk"`,
  `sh -c "export PIP_INDEX_URL=${P} && pip install corp-billing-sdk"`,
  // (b) a config command that changes the registry
  `npm config set registry ${N} && npm i corp-internal`,
  `yarn config set registry ${N} && yarn add corp-internal`,
  `pnpm config set registry ${N}; pnpm add corp-internal`,
  `pip config set global.index-url ${P} && pip install corp-billing-sdk`,
  `uv config set index-url ${P} || uv add corp-billing-sdk`,
  `sudo npm config set registry ${N} && npm i corp-internal`,
  // (c) the Bun and Yarn 1 variables
  `BUN_CONFIG_REGISTRY=${N} bun add corp-internal`,
  `YARN_REGISTRY=${N} yarn add corp-internal`,
  `export YARN_REGISTRY=${N} && yarn add corp-internal`,
  // a setting that comes AFTER the install is also private (conservative)
  `pip install corp-billing-sdk; export PIP_INDEX_URL=${P}`,
  `npm i corp-internal && npm config set registry ${N}`,
];

for (const cmd of PRIVATE) {
  test('whole-command registry setting marks every install: ' + JSON.stringify(cmd), () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1, 'a name was read');
    assert.ok(r.every((x) => x === true), 'registry is true for every name');
  });
}

test('mixed command: both installs are private when one segment exports a registry', () => {
  const r = pc.installsOf(`export PIP_INDEX_URL=${P} && npm i left-pad && pip install corp-billing-sdk`);
  assert.equal(r.length, 2);
  assert.ok(r.every((i) => i.registry === true));
});

const PUBLIC = [
  'export FOO=1 && pip install requests',
  'FOO=1; pip install requests',
  'npm config get registry && npm i lodash',
  'pip config list && pip install requests',
  'npm config set loglevel warn && npm i lodash',
  `PIP_INDEX_URL=${P} echo hi && pip install requests`,
  'export PIP_INDEX_URL= && pip install requests',
];

for (const cmd of PUBLIC) {
  test('still looked up: ' + JSON.stringify(cmd), () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1);
    assert.ok(r.every((x) => x === false), 'registry stays false');
  });
}

test('online: private chains make no request at all', async () => {
  let calls = 0;
  const fetch = () => { calls++; throw new Error('the public registry must not be asked'); };
  const lookup = (items) => reg.lookupMany(items, { fetch });
  for (const cmd of PRIVATE) {
    const r = await pc.check(cmd, { mode: 'online', lookup });
    assert.deepEqual(r.unavailable, [], cmd);
    assert.ok(!r.findings.some((f) => f.kind === 'not_found'), cmd);
  }
  assert.equal(calls, 0);
});

test('privateRegistry reads BUN_CONFIG_REGISTRY and YARN_REGISTRY from the environment', () => {
  assert.equal(reg.privateRegistry('npm', { env: { BUN_CONFIG_REGISTRY: N } }), true);
  assert.equal(reg.privateRegistry('npm', { env: { YARN_REGISTRY: N } }), true);
  assert.equal(reg.privateRegistry('npm', { env: {} }), false);
});
