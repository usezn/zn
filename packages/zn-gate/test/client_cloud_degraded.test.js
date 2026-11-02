'use strict';
// A cloud answer whose decided_by starts with "ml-error" was decided by the rules alone (the model was down). It keeps
// the cloud verdict, and is marked degraded so the caller can tell it apart. A local HTTP server stands in for the gate.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { analyze } = require('../lib/client');

const KEY = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
const TEXT = 'The quarterly report lists the shipping dates for each warehouse.';
const REASON = 'model unavailable, rules only';

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

for (const decidedBy of ['ml-error', 'ml-error-timeout', 'ML-ERROR: model down']) {
  test('a cloud answer decided_by "' + decidedBy + '" is degraded and keeps the cloud verdict', async (t) => {
    withCloud(t);
    const g = await gate({ verdict: 'allow', confidence: 0.2, rule: 'none', decided_by: decidedBy });
    t.after(() => g.server.close());
    const r = await analyze(TEXT, { apiKey: KEY, apiUrl: g.url });
    assert.equal(r.mode, 'hybrid-cloud');
    assert.equal(r.verdict, 'allow');
    assert.equal(r.rule, 'none');
    assert.equal(r.degraded, true);
    assert.equal(r.degraded_reason, REASON);
    assert.equal(r.fallback, undefined);
  });
}

test('a degraded block keeps the block verdict', async (t) => {
  withCloud(t);
  const g = await gate({ verdict: 'block', confidence: 0.9, rule: 'neural', decided_by: 'ml-error' });
  t.after(() => g.server.close());
  const r = await analyze(TEXT, { apiKey: KEY, apiUrl: g.url });
  assert.equal(r.verdict, 'block');
  assert.equal(r.rule, 'neural');
  assert.equal(r.degraded, true);
});

test('a normal cloud answer has no degraded field', async (t) => {
  withCloud(t);
  for (const reply of [
    { verdict: 'allow', confidence: 0.01, rule: 'none', decided_by: 'ml' },
    { verdict: 'block', confidence: 0.99, rule: 'neural', decided_by: 'hybrid-cloud' },
    { verdict: 'allow', confidence: 0.01, rule: 'none' },
  ]) {
    const g = await gate(reply);
    const r = await analyze(TEXT, { apiKey: KEY, apiUrl: g.url });
    g.server.close();
    assert.equal(r.mode, 'hybrid-cloud', JSON.stringify(reply));
    assert.equal('degraded' in r, false, JSON.stringify(reply));
    assert.equal('degraded_reason' in r, false, JSON.stringify(reply));
  }
});

test('zn-gate analyze prints one warning line on stderr for a degraded answer, and not for a normal one', async (t) => {
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  // An allowed text exits 0; the test only reads stdout and stderr, so the exit code is not checked here.
  const run = async (reply) => {
    const g = await gate(reply);
    t.after(() => g.server.close());
    const env = { ...process.env, ZN_STATS: 'off', ZN_CLOUD: '1', ZN_API_KEY: KEY, ZN_API_URL: g.url, ZN_LOCAL_ONLY: '' };
    return new Promise((resolve) => {
      execFile(process.execPath, [cli, 'analyze', TEXT], { env }, (err, stdout, stderr) => resolve({ stdout, stderr }));
    });
  };
  const warn = 'the cloud model was unavailable, so this verdict comes from the cloud gate fallback rules, not from its model';
  const degraded = await run({ verdict: 'allow', confidence: 0.2, rule: 'none', decided_by: 'ml-error' });
  assert.equal(JSON.parse(degraded.stdout).degraded, true);
  assert.equal(degraded.stderr.split('\n').filter((l) => l.includes(warn)).length, 1, degraded.stderr);
  const normal = await run({ verdict: 'allow', confidence: 0.01, rule: 'none', decided_by: 'ml' });
  assert.equal('degraded' in JSON.parse(normal.stdout), false);
  assert.equal(normal.stderr.includes(warn), false, normal.stderr);
});
