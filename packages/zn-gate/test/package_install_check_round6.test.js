'use strict';

process.env.ZN_STATS = 'off';

// Package install check, round 6: a registry mention anywhere in the raw command line makes every install in it private,
// whatever the position (function NAME { ...}, then, do, !) and whatever the form. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/package-check');

const P = 'https://pypi.corp.example.invalid/simple';
const regOf = (cmd) => pc.installsOf(cmd).map((i) => i.registry);

const PRIVATE = [
  `function f { local PIP_INDEX_URL=${P}; pip install corp-internal; }; f`,
  `if true; then export PIP_INDEX_URL=${P}; pip install corp-internal; fi`,
  `for i in 1; do export PIP_INDEX_URL=${P}; pip install corp-internal; done`,
  `! export PIP_INDEX_URL=${P}; pip install corp-internal`,
  // Same family, other forms: a settings file read, a config key, a flag, a Windows setter after a keyword.
  `if true; then cat .npmrc; fi; npm i left-pad`,
  `while false; do npm config set registry ${P}; done; npm i left-pad`,
  `function f { setx PIP_INDEX_URL ${P}; pip install corp-internal; }; f`,
];

for (const cmd of PRIVATE) {
  test(`round 6: private -> ${JSON.stringify(cmd)}`, () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1 && r.every(Boolean), JSON.stringify(r));
  });
}

// Installs that follow a keyword (`then`, `do`, `!`) are not read as installs at all (a known gap of the reader, not a leak).
const PUBLIC = [
  'function f { echo hi; npm i left-pad; }; f',
  'if true; then echo hi; fi; npm i left-pad',
];

for (const cmd of PUBLIC) {
  test(`round 6: stays public -> ${JSON.stringify(cmd)}`, () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1 && r.every((x) => !x), JSON.stringify(r));
  });
}

test('round 6: a private line is never sent to the online lookup', async () => {
  const asked = [];
  const lookup = async (items) => { asked.push(...items); return new Map(); };
  await pc.check(`function f { local PIP_INDEX_URL=${P}; pip install corp-internal; }; f`, { mode: 'online', lookup });
  assert.deepEqual(asked, []);
});
