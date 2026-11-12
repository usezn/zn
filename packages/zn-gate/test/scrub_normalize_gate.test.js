'use strict';

// The scrub engine loads lib/scrub/normalize.js on first use, and only for a text with a candidate (a %XX or a doubled
// quote). A text with no candidate has no decoded view, so skipping the module changes nothing. This file proves it:
// the gate expression is the one normalize.js uses, normalisedView returns null for every candidate-free text (checked
// over fixed and seeded random texts), the engine does not load the module for such a text, and engine.scan gives the
// same spans whether normalize.js was loaded first (the eager path) or not. Child processes start with an empty module
// cache. Values are fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = path.resolve(__dirname, '..', 'lib', 'scrub', 'engine.js');
const NORMALIZE = path.resolve(__dirname, '..', 'lib', 'scrub', 'normalize.js');
const FAKE = path.resolve(__dirname, 'fixtures', 'fake_secrets');

test('the gate expression in the engine is the one normalize.js uses', () => {
  const { CANDIDATE_RE } = require('../lib/scrub/normalize');
  const m = /const NORM_CANDIDATE = \/(.*)\/;/.exec(fs.readFileSync(ENGINE, 'utf8'));
  assert.ok(m, 'NORM_CANDIDATE not found in engine.js');
  assert.equal(m[1], CANDIDATE_RE.source);
  assert.equal(CANDIDATE_RE.flags, 'g');
});

test('normalisedView is null for every text the gate rejects', () => {
  const { normalisedView, CANDIDATE_RE } = require('../lib/scrub/normalize');
  const alphabet = ['a', 'Z', '0', '9', '%', '4', '1', 'F', 'g', "'", '"', ' ', '\n', '=', '_', '-', 'é', '\u0000'];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  let rejected = 0;
  for (let n = 0; n < 20000; n++) {
    let s = '';
    const len = rnd() % 24;
    for (let i = 0; i < len; i++) s += alphabet[rnd() % alphabet.length];
    CANDIDATE_RE.lastIndex = 0;
    if (!CANDIDATE_RE.test(s)) {
      rejected++;
      assert.equal(normalisedView(s), null, JSON.stringify(s));
    }
  }
  assert.ok(rejected > 1000, 'the generator must produce candidate-free texts');
});

const CHILD = `
const Module = require('module');
const { generateAll } = require(${JSON.stringify(FAKE)});
const NL = String.fromCharCode(10), Q1 = String.fromCharCode(39), Q2 = String.fromCharCode(34);
const loaded = () => Object.keys(require.cache).some((k) => k === ${JSON.stringify(NORMALIZE)});
const f = generateAll(31337, { perType: 2, piiPerType: 1 });
const secrets = f.secrets.map((s) => s.value).concat((f.pii || []).map((s) => s.value));
const pct = (v) => v.replace(/[A-Z]/, (c) => '%' + c.charCodeAt(0).toString(16));
const inputs = ['const a = 1;' + NL + 'log(1, { ok: true });', '', 'caf\u00e9 \ud83d\ude00'];
for (const s of secrets) {
  inputs.push(s, 'key=' + s + NL + 'x', pct(s), s.slice(0, 5) + Q1 + Q1 + s.slice(5), s.slice(0, 5) + Q2 + Q2 + s.slice(5));
}
const mode = process.argv[1] === 'eager';
if (mode) require(${JSON.stringify(NORMALIZE)});
const engine = require(${JSON.stringify(ENGINE)});
const out = [];
let loadedAfterClean = null;
for (const t of inputs) {
  out.push(JSON.stringify(engine.scan(t)));
  if (loadedAfterClean === null && t.length && !/%[0-9A-Fa-f]{2}|''|""/.test(t)) loadedAfterClean = loaded();
}
console.log(JSON.stringify({ out, loadedAfterClean }));
`;

function run(mode) {
  const r = spawnSync(process.execPath, ['-e', CHILD, mode], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('engine.scan gives the same spans with the module loaded first or on demand, and does not load it for a clean text', () => {
  const lazy = run('lazy');
  const eager = run('eager');
  assert.deepEqual(lazy.out, eager.out);
  assert.equal(lazy.loadedAfterClean, false);
});
