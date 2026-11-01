'use strict';
// The command line exit code follows the cloud verdict contract: a reply whose verdict is not "allow" or "block"
// (another word, another type) blocks the text and exits 2, never 0. A local HTTP server stands in for the gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const KEY = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
const TEXT = 'The quarterly report lists the shipping dates for each warehouse.';

function gate(reply) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/v30/analyze' })));
}

function runCli(url, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_STATS: 'off',
    ZN_API_KEY: KEY, ZN_CLOUD: '1', ZN_API_URL: url };
  delete env.ZN_LOCAL_ONLY;
  // Asynchronous on purpose: the stand-in gate runs in this process and must keep answering.
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'analyze', TEXT], { env, timeout: 30000 }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, stdout });
    });
  });
}

for (const [reply, code, verdict, rule] of [
  [{ verdict: 'DENY', confidence: 0.99, rule: 'fake:attack' }, 2, 'block', 'cloud:unknown-verdict'],
  [{ verdict: 1, confidence: 0.99, rule: 'neural' }, 2, 'block', 'cloud:unknown-verdict'],
  [{ verdict: 'Allow', confidence: 0.01, rule: 'none' }, 0, 'allow', 'none'],
]) {
  test('zn-gate analyze with a cloud reply ' + JSON.stringify(reply.verdict) + ' exits ' + code, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cli-verdict-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const { server, url } = await gate(reply);
    t.after(() => server.close());
    const r = await runCli(url, home);
    assert.equal(r.code, code, r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verdict, verdict);
    assert.equal(out.rule, rule);
    assert.equal(out.mode, 'hybrid-cloud');
  });
}
