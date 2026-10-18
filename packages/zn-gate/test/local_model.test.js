'use strict';
// The on-device model path, with a stand-in backend: no model, no runtime, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const lm = require('../lib/local-model');
const { analyze } = require('../lib/client');

// A fake model: the margin is the number of "alpha" tokens, minus 1.
function backend(calls) {
  return {
    specials: { bos: 2, eos: 1 },
    tokenize: (flat) => flat.split(' ').map((w) => (w === 'alpha' ? 7 : 5)),
    margin: async (ids) => { calls.push(ids); return ids.filter((x) => x === 7).length - 1; },
  };
}

function withEnv(t, env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-lm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the model is off unless asked for', (t) => {
  withEnv(t, { ZN_LOCAL_MODEL: undefined });
  assert.equal(lm.isEnabled(), false);
  withEnv(t, { ZN_LOCAL_MODEL: '1' });
  assert.equal(lm.isEnabled(), true);
  assert.equal(lm.isEnabled({ localModel: false }), false);
});

test('whitespace is flattened like the training input', () => {
  assert.equal(lm.flatten('  a\t\tb\n\nc  '), 'a b c');
  assert.equal(lm.flatten('a b　c'), 'a b c');
  assert.equal(lm.flatten(null), '');
});

test('the verdict has the usual shape and uses the pinned threshold', async () => {
  const calls = [];
  const deny = await lm.analyze('alpha alpha alpha', { localModelBackend: backend(calls) });
  assert.equal(deny.ready, true);
  assert.equal(deny.result.verdict, 'block');
  assert.equal(deny.result.mode, 'local-model');
  assert.equal(deny.result.engine, 'galvanize2-int8-local');
  assert.equal(calls[0][0], 2);
  assert.equal(calls[0][calls[0].length - 1], 1);
  const ok = await lm.analyze('just words', { localModelBackend: backend([]) });
  assert.equal(ok.result.verdict, 'allow');
  assert.ok(ok.result.confidence > 0.5 && ok.result.confidence <= 1);
});

test('long text is scored in overlapping windows and the highest one wins', async () => {
  const calls = [];
  const words = new Array(1200).fill('word');
  words[1100] = 'alpha';
  words[1101] = 'alpha';
  const r = await lm.analyze(words.join(' '), { localModelBackend: backend(calls) });
  assert.ok(calls.length > 1);
  assert.ok(calls.every((c) => c.length <= 512));
  assert.equal(r.result.verdict, 'block');
  const single = await lm.analyze(words.join(' '), { localModelBackend: backend([]), windows: false });
  assert.equal(single.result.verdict, 'allow');
});

test('analyze() uses the model when it is on and sends nothing', async (t) => {
  withEnv(t, { ZN_LOCAL_MODEL: '1', ZN_CLOUD: '1', ZN_API_KEY: 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2' });
  const orig = https.request;
  let net = 0;
  https.request = () => { net++; throw new Error('network used'); };
  t.after(() => { https.request = orig; });
  const r = await analyze('alpha alpha', { localModelBackend: backend([]) });
  assert.equal(r.mode, 'local-model');
  assert.equal(r.verdict, 'block');
  assert.equal(net, 0);
});

test('without the model files analyze() falls back and says why', async (t) => {
  const dir = tmpDir(t);
  withEnv(t, { ZN_LOCAL_MODEL: '1', ZN_MODEL_DIR: dir, ZN_CLOUD: undefined, ZN_API_KEY: undefined, ZN_HOME: dir });
  const r = await analyze('hello there');
  assert.equal(r.mode, 'oss-local');
  assert.match(r.local_model_unavailable, /not cached/);
  assert.equal(lm.status().cached, false);
});

test('pull() refuses a model with no pinned hash', async (t) => {
  const dir = tmpDir(t);
  withEnv(t, { ZN_MODEL_DIR: dir });
  await assert.rejects(() => lm.pull(), /not published yet/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('pull() only talks to Hugging Face', async (t) => {
  const dir = tmpDir(t);
  withEnv(t, { ZN_MODEL_DIR: dir });
  const hashes = { 'model_int8.onnx': 'a'.repeat(64) };
  await assert.rejects(() => lm.pull({ hashes, baseUrl: 'https://example.com/x/' }), /refusing to download/);
  assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), false);
});

test('a huge text is cut and the result says the end was not analyzed', async () => {
  const text = 'word '.repeat(10000);
  const r = await lm.analyze(text, { localModelBackend: backend([]) });
  assert.equal(r.ready, true);
  assert.match(r.result.warning, /not analyzed/);
});
