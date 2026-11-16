'use strict';
// A failed cloud call prints one warning in verbose mode. The wording matches the Python package.
// A local HTTP server stands in for the gate; nothing leaves the machine.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyze } = require('../lib/client');

const KEY = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
// Neutral text: no local rule fires on it.
const TEXT = 'The quarterly report lists the shipping dates for each warehouse.';
const TAIL = ' The local rules were used instead, so the text was checked on this machine only.';

function server(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    srv,
    url: 'http://127.0.0.1:' + srv.address().port + '/v30/analyze',
  })));
}

function closeServer(srv) {
  if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
  srv.close();
}

// Runs analyze() with verbose output on and returns the result and the warning lines written to stderr.
async function run(t, url, options = {}) {
  const keys = ['ZN_VERBOSE', 'ZN_CLOUD'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.ZN_VERBOSE = '1';
  process.env.ZN_CLOUD = '1';
  const write = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  t.after(() => {
    process.stderr.write = write;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  let r;
  try {
    r = await analyze(TEXT, { apiKey: KEY, apiUrl: url, ...options });
  } finally {
    process.stderr.write = write;
  }
  const warnings = captured.split('\n').filter((l) => l.startsWith('[zn-gate] Warning: Cloud gate error'));
  return { r, warnings };
}

test('a 401 answer says the key was not accepted and that only local rules were used', async (t) => {
  const g = await server((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 401; res.end('no'); }); });
  t.after(() => closeServer(g.srv));
  const { r, warnings } = await run(t, g.url);
  assert.strictEqual(r.mode, 'oss-local');
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.strictEqual(warnings[0],
    '[zn-gate] Warning: Cloud gate error (Gateway responded with HTTP 401: no). ' +
    'The cloud service did not accept the API key: check ZN_API_KEY.' + TAIL);
});

test('a 503 answer says the service failed and to try again later', async (t) => {
  const g = await server((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 503; res.end('busy'); }); });
  t.after(() => closeServer(g.srv));
  const { warnings } = await run(t, g.url);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0],
    '[zn-gate] Warning: Cloud gate error (Gateway responded with HTTP 503: busy). ' +
    'The cloud service answered with an error (HTTP 503): try again later.' + TAIL);
});

test('a slow answer says the service took too long and to check the network', async (t) => {
  const g = await server(() => { /* never answers */ });
  t.after(() => closeServer(g.srv));
  const { warnings } = await run(t, g.url, { timeout: 50 });
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0],
    '[zn-gate] Warning: Cloud gate error (Gateway request timed out). ' +
    'The cloud service took too long to answer: check your network connection.' + TAIL);
});

test('an unreachable service says it could not be reached', async (t) => {
  const g = await server(() => {});
  const port = g.srv.address().port;
  await new Promise((resolve) => g.srv.close(resolve));
  const { warnings } = await run(t, 'http://127.0.0.1:' + port + '/v30/analyze');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^\[zn-gate\] Warning: Cloud gate error \(connect ECONNREFUSED [^)]*\)\. The cloud service could not be reached: check your network connection and ZN_API_URL\. The local rules were used instead, so the text was checked on this machine only\.$/);
});

test('the warning wording matches the Python package', (t) => {
  const py = path.join(__dirname, '..', '..', 'zn-gate-py', 'src', 'zn_gate', 'client.py');
  if (!fs.existsSync(py)) { t.skip('zn-gate-py is not in this checkout'); return; }
  const text = fs.readFileSync(py, 'utf8');
  const phrases = [
    'The cloud service did not accept the API key: check ZN_API_KEY.',
    'The cloud service answered with an error (HTTP ',
    'try again later.',
    'The cloud service took too long to answer: check your network connection.',
    'The cloud service could not be reached: check your network connection and ZN_API_URL.',
    'The cloud check failed.',
    'The local rules were used instead, so the text was checked on this machine only.',
  ];
  for (const p of phrases) assert.ok(text.includes(p), 'missing in Python: ' + p);
});
