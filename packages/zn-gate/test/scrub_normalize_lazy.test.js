'use strict';

// The scrub engine loads lib/scrub/normalize.js on first use, and only for a text that has a candidate (a %XX, '' or "").
// A text with no candidate has no decoded view (normalisedView returns null for it), so skipping the module changes
// nothing. This file proves that: the candidate expression is the same one normalize.js uses, normalisedView is null for
// every candidate-free text, and engine.scan gives the same spans as an engine copy whose gate always lets the text
// through (the eager path), over fake secrets of every type plus generated texts. Run in child processes so the module
// cache starts empty. Values are fake.

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
  const src = fs.readFileSync(ENGINE, 'utf8');
  const m = /const NORM_CANDIDATE = \/(.*)\/;/.exec(src);
  assert.ok(m, 'NORM_CANDIDATE not found in engine.js');
  assert.equal(m[1], CANDIDATE_RE.source);
  assert.equal(CANDIDATE_RE.flags, 'g');
});

const CHILD = `
const fs = require('fs');
const Module = require('module');
const { generateAll } = require(${JSON.stringify(FAKE)});
const NL = String.fromCharCode(10);
const Q1 = String.fromCharCode(39);
const Q2 = String.fromCharCode(34);
const f = generateAll(31337, { perType: 2, piiPerType: 1 });
const secrets = f.secrets.map((s) => s.value).concat((f.pii || []).map((s) => s.value));
const aws = f.secrets.find((s) => s.type === 'aws_access_key_id').value;
const ghp = f.secrets.find((s) => s.type === 'github_pat_classic').value;
const pct = (v) => v.replace(/[A-Z]/, (c) => '%' + c.charCodeAt(0).toString(16));
const inputs = [
  ['const a = 1;', 'logger.info(' + Q2 + 'done' + Q2 + ', { ok: true });', ''].join(NL),
  'AWS_ACCESS_KEY_ID=' + aws,
  'export K=' + aws.slice(0, 6) + Q1 + Q1 + aws.slice(6),
  'export K=' + aws.slice(0, 6) + Q2 + Q2 + aws.slice(6),
  'token: ' + ghp,
  'curl ' + Q2 + 'https://example.com/?api_key=' + pct(ghp) + Q2,
  'echo 100%done and %zz and %41 stray',
  'x = ' + Q2 + Q2 + ' + y + ' + Q1 + Q1,
  '',
  'caf\\u00e9 \\u4e2d\\u6587 \\ud83d\\ude00 ' + aws,
  'caf\\u00e9 %C3%A9 %41KIA ' + Q1 + Q1 + ' end',
];
for (const s of secrets) {
  inputs.push(s);
  inputs.push('key=' + s + NL + 'other line');
  inputs.push(pct(s));
  inputs.push(s.slice(0, 5) + Q1 + Q1 + s.slice(5));
  inputs.push(s.slice(0, 5) + Q2 + Q2 + s.slice(5));
  inputs.push('caf\\u00e9 ' + s + ' \\ud83d\\ude00');
}
// Generated texts: every mix of plain, %XX, doubled quotes, a lone %, unicode.
const parts = ['abc', 'AKIA', '%41', '%zz', '%', Q1 + Q1, Q2 + Q2, Q1, Q2, '\\u00e9', NL, ' ', 'token=', aws.slice(0, 8)];
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 400; i++) {
  let t = '';
  const n = 1 + Math.floor(rnd() * 8);
  for (let k = 0; k < n; k++) t += parts[Math.floor(rnd() * parts.length)];
  inputs.push(t);
}

const normPath = ${JSON.stringify(NORMALIZE)};
const enginePath = ${JSON.stringify(ENGINE)};
const loaded = () => Object.keys(require.cache).includes(normPath);
const engine = require(enginePath);
const loadedAfterRequire = loaded();
const candidateFree = inputs.filter((t) => !/%[0-9A-Fa-f]{2}|''|""/.test(t));
const lazyResults = inputs.map((t) => JSON.stringify(engine.scan(t, { pii: true })));
// Candidate-free texts only first, in a second process (below); here the module is allowed to load for the rest.

// The eager copy: the same source with the gate always open.
const src = fs.readFileSync(enginePath, 'utf8');
const eagerSrc = src.replace(/const NORM_CANDIDATE = .*;/, 'const NORM_CANDIDATE = /(?:)/;');
if (eagerSrc === src) throw new Error('gate line not found');
const m = new Module(enginePath, null);
m.filename = enginePath;
m.paths = Module._nodeModulePaths(require('path').dirname(enginePath));
m._compile(eagerSrc, enginePath);
const eager = m.exports;
const eagerResults = inputs.map((t) => JSON.stringify(eager.scan(t, { pii: true })));
const norm = require(normPath);
const nonNullForFree = candidateFree.filter((t) => norm.normalisedView(t) !== null).length;
let diffs = 0;
for (let i = 0; i < inputs.length; i++) if (lazyResults[i] !== eagerResults[i]) diffs++;
process.stdout.write(JSON.stringify({ n: inputs.length, free: candidateFree.length, diffs, nonNullForFree, loadedAfterRequire, spansFound: lazyResults.filter((r) => r !== '[]').length }));
`;

const CHILD_FREE = `
const path = require('path');
const { generateAll } = require(${JSON.stringify(FAKE)});
const f = generateAll(31337, { perType: 1, piiPerType: 0 });
const aws = f.secrets.find((s) => s.type === 'aws_access_key_id').value;
const NL = String.fromCharCode(10);
const normPath = ${JSON.stringify(NORMALIZE)};
const engine = require(${JSON.stringify(ENGINE)});
const loaded = () => Object.keys(require.cache).includes(normPath);
const before = loaded();
const texts = ['plain', '', 'AWS_ACCESS_KEY_ID=' + aws, ['const a = 1;', 'x = { ok: true };', ''].join(NL), 'caf\\u00e9 \\ud83d\\ude00 100%done %zz'];
for (const t of texts) engine.scan(t, { pii: true });
const afterFree = loaded();
engine.scan('x = %41KIA', { pii: true });
process.stdout.write(JSON.stringify({ before, afterFree, afterCandidate: loaded() }));
`;

function run(code) {
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off' } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('normalize.js is not loaded by the engine for candidate-free texts, and is for a text with a candidate', () => {
  const r = run(CHILD_FREE);
  assert.equal(r.before, false);
  assert.equal(r.afterFree, false);
  assert.equal(r.afterCandidate, true);
});

test('engine.scan equals the eager path over fake secrets and generated texts; candidate-free texts have no view', () => {
  const r = run(CHILD);
  assert.equal(r.loadedAfterRequire, false);
  assert.ok(r.n > 500 && r.free > 50, JSON.stringify(r));
  assert.equal(r.diffs, 0);
  assert.equal(r.nonNullForFree, 0);
  assert.ok(r.spansFound > 20, 'the inputs must contain secrets that are found');
});
