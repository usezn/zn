'use strict';
// The cloud verdict is read without case or spaces where it is parsed, and an unknown one blocks (fail closed).
// A local HTTP server stands in for the gate; nothing leaves the machine.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { analyze, _cloudVerdict } = require('../lib/client');

const KEY = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
const TEXT = 'The quarterly report lists the shipping dates for each warehouse.';

function gate(reply) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/v30/analyze' })));
}

function withCloud(t) {
  const saved = {};
  for (const [k, v] of Object.entries({ ZN_CLOUD: '1', ZN_LOCAL_ONLY: undefined, ZN_LONG_INPUT: undefined })) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('the helper lowercases allow and block and blocks anything else', () => {
  for (const [v, want] of [['allow', 'allow'], ['block', 'block'], ['BLOCK', 'block'], ['Block', 'block'], [' block ', 'block'], ['ALLOW', 'allow'], ['Allow', 'allow']]) {
    const r = _cloudVerdict({ verdict: v, confidence: 0.4, rule: 'r' });
    assert.equal(r.verdict, want, v);
    assert.equal(r.rule, 'r', v);
  }
  for (const v of ['deny', 'blocked', '', null, undefined, 1, true, ['block'], { v: 'block' }]) {
    const r = _cloudVerdict({ verdict: v, confidence: 0.1, rule: 'x' });
    assert.equal(r.verdict, 'block', String(v));
    assert.equal(r.rule, 'cloud:unknown-verdict', String(v));
  }
  for (const body of [null, [], 'block', 7]) assert.throws(() => _cloudVerdict(body), TypeError, JSON.stringify(body));
});

test('a reply that is not a JSON object is a cloud error: the local rules decide', async (t) => {
  withCloud(t);
  for (const reply of [null, [], 'block']) {
    const g = await gate(reply);
    const r = await analyze(TEXT, { apiKey: KEY, apiUrl: g.url });
    g.server.close();
    assert.equal(r.mode, 'oss-local', JSON.stringify(r));
    assert.equal(r.fallback, true);
    assert.equal(r.verdict, 'allow');
  }
});

for (const [reply, want, rule] of [
  [{ verdict: 'BLOCK', confidence: 0.99, rule: 'neural' }, 'block', 'neural'],
  [{ verdict: 'Block', confidence: 0.99, rule: 'neural' }, 'block', 'neural'],
  [{ verdict: 'Allow', confidence: 0.01, rule: 'none' }, 'allow', 'none'],
  [{ verdict: 'maybe', confidence: 0.5, rule: 'neural' }, 'block', 'cloud:unknown-verdict'],
  [{ confidence: 0.5 }, 'block', 'cloud:unknown-verdict'],
]) {
  test('analyze() with a cloud reply ' + JSON.stringify(reply.verdict) + ' gives ' + want, async (t) => {
    withCloud(t);
    const g = await gate(reply);
    t.after(() => g.server.close());
    const r = await analyze(TEXT, { apiKey: KEY, apiUrl: g.url });
    assert.equal(r.mode, 'hybrid-cloud', JSON.stringify(r));
    assert.equal(r.verdict, want);
    assert.equal(r.rule, rule);
  });
}
