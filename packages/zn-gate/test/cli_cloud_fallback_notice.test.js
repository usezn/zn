'use strict';
// With ZN_CLOUD=1 and the cloud unreachable, `analyze` keeps the local result and exit code and prints one short
// line on stderr (no URL, key or text). Most tests use a refused local port; one uses the reserved documentation
// address 192.0.2.1. Nothing leaves the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const KEY = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
const TEXT = 'The quarterly report lists the shipping dates for each warehouse.';
const START = 'zn-gate: cloud check unavailable (';
const END = '); using the local result\n';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function runCli(extraEnv, url) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-fb-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_STATS: 'off',
    ZN_API_KEY: KEY, ZN_CLOUD: '1', ZN_API_URL: url, ...extraEnv };
  delete env.ZN_LOCAL_ONLY;
  if (!('ZN_VERBOSE' in extraEnv)) { delete env.ZN_VERBOSE; delete env.DEBUG; }
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'analyze', TEXT], { env, timeout: 30000 }, (err, stdout, stderr) => {
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test('an unreachable cloud keeps the local result and prints one short line', async () => {
  const url = 'http://127.0.0.1:' + (await freePort()) + '/v30/analyze';
  const r = await runCli({}, url);
  assert.equal(r.code, 0);
  const res = JSON.parse(r.stdout);
  assert.equal(res.verdict, 'allow');
  assert.equal(res.fallback, true);
  assert.ok(r.stderr.startsWith(START) && r.stderr.endsWith(END), r.stderr);
  assert.equal(r.stderr.split('\n').length, 2);
  for (const leak of [KEY, '127.0.0.1', 'quarterly']) assert.ok(!r.stderr.includes(leak), leak);
});

test('a reserved documentation address gives the same one line', async () => {
  const r = await runCli({}, 'http://192.0.2.1:9/v30/analyze');
  assert.equal(r.code, 0);
  assert.ok(r.stderr.startsWith(START), r.stderr);
  assert.equal(r.stderr.split('\n').length, 2);
});

test('no line without the cloud check', async () => {
  const r = await runCli({ ZN_CLOUD: '0' }, 'http://127.0.0.1:9/v30/analyze');
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
});

test('with ZN_VERBOSE the detail line is printed, not a second one', async () => {
  const url = 'http://127.0.0.1:' + (await freePort()) + '/v30/analyze';
  const r = await runCli({ ZN_VERBOSE: '1' }, url);
  assert.ok(r.stderr.includes('Cloud gate error'), r.stderr);
  assert.ok(!r.stderr.includes(START), r.stderr);
});

test('a library call prints nothing by default', async () => {
  const { analyze } = require('../lib/client');
  const keys = ['ZN_CLOUD', 'ZN_VERBOSE', 'DEBUG'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.ZN_CLOUD = '1'; delete process.env.ZN_VERBOSE; delete process.env.DEBUG;
  const url = 'http://127.0.0.1:' + (await freePort()) + '/v30/analyze';
  const write = process.stderr.write;
  let captured = '';
  process.stderr.write = (c) => { captured += String(c); return true; };
  let res;
  try {
    res = await analyze(TEXT, { apiKey: KEY, apiUrl: url, timeout: 500 });
  } finally {
    process.stderr.write = write;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  assert.equal(res.fallback, true);
  assert.equal(captured, '');
});
