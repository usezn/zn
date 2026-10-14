'use strict';
// Long texts ask the cloud gate for overlapping windows ("long_input": "windows").
// A local HTTP server stands in for the gate; nothing leaves the machine.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { analyze, longInputMode, LONG_INPUT_MIN_CHARS } = require('../lib/client');

const KEY = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
// Neutral filler text: no rule fires on it.
const SENTENCE = 'The quarterly report lists the shipping dates for each warehouse. ';

function gate(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply(parsed)));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: 'http://127.0.0.1:' + server.address().port + '/v30/analyze' })));
}

function withCloud(t, extraEnv = {}) {
  const saved = {};
  const env = { ZN_CLOUD: '1', ZN_LOCAL_ONLY: undefined, ZN_LONG_INPUT: undefined, ...extraEnv };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

const allow = (body) => ({
  verdict: 'allow', confidence: 0.1, billed_calls: Math.max(1, 1 + Math.ceil((body.input.length - 2000) / 1000)), input_chars: body.input.length,
  ...(body.long_input === 'windows' ? { long_input: { mode: 'windows', windows: 3, top_window: 2, capped: false } } : {}),
});

test('a long text asks for windows; a short one is sent as before', async (t) => {
  withCloud(t);
  const g = await gate(allow);
  t.after(() => g.server.close());
  const long = SENTENCE.repeat(40);
  assert.ok(long.length > LONG_INPUT_MIN_CHARS);
  const r = await analyze(long, { apiKey: KEY, apiUrl: g.url });
  assert.strictEqual(r.mode, 'hybrid-cloud', JSON.stringify(r));
  assert.strictEqual(g.seen[0].long_input, 'windows');
  assert.deepStrictEqual(r.long_input, { mode: 'windows', windows: 3, top_window: 2, capped: false });
  // The gate's billing fields reach the caller unchanged.
  assert.strictEqual(r.billed_calls, 2);
  assert.strictEqual(r.input_chars, long.length);
  assert.strictEqual(r.warning, undefined);

  await analyze(SENTENCE, { apiKey: KEY, apiUrl: g.url });
  assert.deepStrictEqual(Object.keys(g.seen[1]), ['input'], 'a short request is unchanged');
});

test('ZN_LONG_INPUT=off and --long-input off keep the first-512-tokens request', async (t) => {
  withCloud(t, { ZN_LONG_INPUT: 'off' });
  const g = await gate(allow);
  t.after(() => g.server.close());
  await analyze(SENTENCE.repeat(40), { apiKey: KEY, apiUrl: g.url });
  assert.strictEqual(g.seen[0].long_input, undefined);
  process.env.ZN_LONG_INPUT = 'windows';
  await analyze(SENTENCE.repeat(40), { apiKey: KEY, apiUrl: g.url, longInput: 'off' });
  assert.strictEqual(g.seen[1].long_input, undefined);
  assert.strictEqual(longInputMode({ longInput: 'OFF' }), 'off');
  assert.strictEqual(longInputMode({ longInput: 'windows' }), 'windows');
});

test('a capped answer adds a warning that the end was not analyzed', async (t) => {
  withCloud(t);
  const g = await gate(() => ({ verdict: 'allow', confidence: 0.1, long_input: { mode: 'windows', windows: 20, top_window: 0, capped: true } }));
  t.after(() => g.server.close());
  const r = await analyze(SENTENCE.repeat(300), { apiKey: KEY, apiUrl: g.url });
  assert.match(r.warning, /end was not analyzed/);
});

test('a fallback answer that checked only the first 512 tokens adds a warning', async (t) => {
  withCloud(t);
  const g = await gate(() => ({ verdict: 'allow', confidence: 0.1, long_input: { mode: 'truncate', reason: 'fallback' } }));
  t.after(() => g.server.close());
  const r = await analyze(SENTENCE.repeat(40), { apiKey: KEY, apiUrl: g.url });
  assert.match(r.warning, /only the first 512 tokens of this text \(fallback\)/);
});

test('CLI: --long-input takes only windows or off and never swallows --local-only', (t) => {
  const { spawnSync } = require('child_process');
  const CLI = require('path').join(__dirname, '..', 'bin', 'cli.js');
  const env = { ...process.env, ZN_CLOUD: '1', ZN_API_KEY: KEY, ZN_API_URL: 'http://127.0.0.1:9/v30/analyze' };
  for (const args of [['--long-input', '--local-only'], ['--long-input', 'maybe']]) {
    const r = spawnSync(process.execPath, [CLI, 'analyze', 'hello there', ...args], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 2, args.join(' ') + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, /--long-input needs windows or off/);
    assert.doesNotMatch(r.stdout, /cloud_error/);
  }
  const ok = spawnSync(process.execPath, [CLI, 'analyze', 'hello there', '--long-input', 'off', '--local-only'], { env, encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout, /cloud_error/);
});

test('without the cloud nothing is sent, long or not', async (t) => {
  withCloud(t, { ZN_CLOUD: undefined });
  const g = await gate(allow);
  t.after(() => g.server.close());
  const r = await analyze(SENTENCE.repeat(40), { apiKey: KEY, apiUrl: g.url });
  assert.strictEqual(r.mode, 'oss-local');
  assert.strictEqual(g.seen.length, 0);
});
