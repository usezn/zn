'use strict';

process.env.ZN_STATS = 'off';

// Package install check, round 5: the clobber redirect `>|` to a settings file, and brace groups with local, typeset
// and readonly. Every setter makes all installs in the line private. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../lib/package-check');

const N = 'https://npm.corp.example.invalid';
const P = 'https://pypi.corp.example.invalid/simple';
const regOf = (cmd) => pc.installsOf(cmd).map((i) => i.registry);

const SETTERS = [
  `echo "registry=${N}" >| .npmrc && npm i corp-internal`,
  `echo registry=${N} >|.npmrc; npm i corp-internal`,
  `echo registry=${N} >| .npmrc\nnpm i corp-internal`,
  `sh -c 'echo registry=${N} >| .npmrc && npm i corp-internal'`,
  `{ export PIP_INDEX_URL=${P}; pip install corp-internal; }`,
  `{ export PIP_INDEX_URL=${P} && pip install corp-internal; }`,
  `f() { local PIP_INDEX_URL=${P}; pip install corp-internal; }; f`,
  `f() { typeset PIP_INDEX_URL=${P}; pip install corp-internal; }; f`,
  `{ readonly PIP_INDEX_URL=${P}; pip install corp-internal; }`,
  `local PIP_INDEX_URL=${P}; pip install corp-internal`,
  `typeset PIP_INDEX_URL=${P}; pip install corp-internal`,
  `readonly PIP_INDEX_URL=${P}; pip install corp-internal`,
  `{ declare -x PIP_INDEX_URL=${P}; pip install corp-internal; }`,
];

for (const cmd of SETTERS) {
  test(`round 5: private -> ${JSON.stringify(cmd)}`, () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1 && r.every(Boolean), JSON.stringify(r));
  });
}

for (const cmd of [
  'cat .npmrc && npm i left-pad',
  'grep registry .npmrc && npm i left-pad',
  'echo hello > notes.txt && npm i left-pad',
  'echo hello >| notes.txt && npm i left-pad',
  '{ echo hi; npm i left-pad; }',
  '{ pip install requests; }',
]) {
  test(`round 5: stays public -> ${JSON.stringify(cmd)}`, () => {
    const r = regOf(cmd);
    assert.ok(r.length >= 1 && r.every((x) => !x), JSON.stringify(r));
  });
}
