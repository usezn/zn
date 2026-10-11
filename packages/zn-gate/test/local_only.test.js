'use strict';

/*
 * 1.4.1 data-flow guarantees:
 *  - tool results and tool-call arguments never leave the machine and always
 *    come back secret-redacted;
 *  - with ZN_API_KEY but without ZN_CLOUD=1 nothing is sent;
 *  - with ZN_API_KEY + ZN_CLOUD=1 only analyze_prompt is sent, redacted.
 *
 * All secrets below are invented values with a valid format, assembled at
 * runtime so that secret scanners don't flag this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const FAKE = {
  aws: 'AKIA' + 'ZNTESTFAKE' + '000000',
  github: 'ghp_' + 'zntestfake'.repeat(3) + 'abcdef',
  dbPassword: 'zn-fake-pw-' + '42',
  apiKey: 'zn_test_' + 'notarealkey_0000',
};
const DB_URL = `postgres://app:${FAKE.dbPassword}@db.internal:5432/main`;
const SECRET_BLOB = `Current settings:\nAWS_ACCESS_KEY_ID=${FAKE.aws}\ntoken: ${FAKE.github}\nDATABASE_URL=${DB_URL}\n`;

function assertNoRawSecrets(text, where) {
  for (const v of [FAKE.aws, FAKE.github, FAKE.dbPassword]) {
    assert.ok(!text.includes(v), `${where} still contains a raw secret`);
  }
}

// ---------------------------------------------------------------------------
// In-process: mock https.request / http.request and count calls
// ---------------------------------------------------------------------------
const origHttps = https.request;
const origHttp = http.request;
let calls = [];

function installMock() {
  calls = [];
  const fake = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (d) => { body += d; };
    req.end = () => {
      calls.push({ url: String(url), body });
      const res = new EventEmitter();
      res.statusCode = 200;
      if (cb) cb(res);
      process.nextTick(() => {
        res.emit('data', JSON.stringify({ verdict: 'allow', confidence: 0.9 }));
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  };
  https.request = fake;
  http.request = fake;
}

function restoreMock() {
  https.request = origHttps;
  http.request = origHttp;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of ['ZN_API_KEY', 'ZN_CLOUD', 'ZN_LOCAL_ONLY', 'ZN_API_URL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const { analyze, checkToolResult, isCloudEnabled } = require('../lib/client');

test('(a) tool result with secrets comes back redacted and makes no HTTP request, even with ZN_API_KEY + ZN_CLOUD=1', async () => {
  installMock();
  try {
    await withEnv({ ZN_API_KEY: FAKE.apiKey, ZN_CLOUD: '1' }, async () => {
      const res = await checkToolResult('read_file', SECRET_BLOB);
      assert.equal(res.safe_to_ingest, true);
      assert.ok(res.secrets_redacted >= 3, `expected >=3 redactions, got ${res.secrets_redacted}`);
      assert.ok(res.sanitized_content.includes('[REDACTED_AWS_KEY]'));
      assert.ok(res.sanitized_content.includes('[REDACTED_GITHUB_TOKEN]'));
      assert.ok(res.sanitized_content.includes('[REDACTED_DB_PASSWORD]'));
      assertNoRawSecrets(res.sanitized_content, 'sanitized_content');
    });
    assert.equal(calls.length, 0, 'checkToolResult must never make a network request');
  } finally {
    restoreMock();
  }
});

test('(a2) tool result with secrets is redacted without any API key either', async () => {
  installMock();
  try {
    await withEnv({}, async () => {
      const res = await checkToolResult('bash', { stdout: SECRET_BLOB });
      assertNoRawSecrets(res.sanitized_content, 'sanitized_content (object input)');
    });
    assert.equal(calls.length, 0);
  } finally {
    restoreMock();
  }
});

test('(b) ZN_API_KEY without ZN_CLOUD: analyze() makes no HTTP request', async () => {
  installMock();
  try {
    await withEnv({ ZN_API_KEY: FAKE.apiKey }, async () => {
      assert.equal(isCloudEnabled(), false);
      const res = await analyze('Please summarize this README for me.');
      assert.equal(res.verdict, 'allow');
      assert.equal(res.mode, 'oss-local');
      assert.equal(res.tip, undefined, 'no "set ZN_API_KEY" upsell tip any more');
      const res2 = await analyze('hello', { apiKey: FAKE.apiKey });
      assert.equal(res2.mode, 'oss-local');
    });
    assert.equal(calls.length, 0);
  } finally {
    restoreMock();
  }
});

test('(b2) ZN_LOCAL_ONLY=true wins over ZN_CLOUD=1', async () => {
  installMock();
  try {
    await withEnv({ ZN_API_KEY: FAKE.apiKey, ZN_CLOUD: '1', ZN_LOCAL_ONLY: 'true' }, async () => {
      await analyze('Please summarize this README for me.');
    });
    assert.equal(calls.length, 0);
  } finally {
    restoreMock();
  }
});

test('(c) ZN_CLOUD=1 + key: analyze() sends one request and the body is secret-redacted', async () => {
  installMock();
  try {
    await withEnv({ ZN_API_KEY: FAKE.apiKey, ZN_CLOUD: '1' }, async () => {
      const res = await analyze(`Please review these settings. ${SECRET_BLOB}`);
      assert.equal(res.mode, 'hybrid-cloud');
      assert.ok(res.secrets_redacted_before_upload >= 3);
    });
    assert.equal(calls.length, 1);
    assertNoRawSecrets(calls[0].body, 'cloud request body');
    assert.ok(calls[0].body.includes('[REDACTED_AWS_KEY]'));
  } finally {
    restoreMock();
  }
});

// ---------------------------------------------------------------------------
// End-to-end: real child processes, real local HTTP server counting hits
// ---------------------------------------------------------------------------
function startCountingServer() {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ verdict: 'allow', confidence: 0.9 }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, url: `http://127.0.0.1:${srv.address().port}/v30/analyze` }));
  });
}

function rpcSession(child) {
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const w = waiters.get(msg.id);
        if (w) {
          waiters.delete(msg.id);
          w(msg);
        }
      } catch (_) {}
    }
  });
  return (msg) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for id ${msg.id}`)), 8000);
      waiters.set(msg.id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(JSON.stringify(msg) + '\n');
    });
}

function childEnv(extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  delete env.ZN_LOCAL_ONLY;
  return { env, home };
}

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('(e2e) MCP server with ZN_API_KEY + ZN_CLOUD=1: check_tool_result / check_tool_call send nothing; analyze_prompt sends redacted text', async () => {
  const { srv, hits, url } = await startCountingServer();
  const { env, home } = childEnv({ ZN_API_KEY: FAKE.apiKey, ZN_CLOUD: '1', ZN_API_URL: url });
  const child = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const call = rpcSession(child);
  try {
    const r1 = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_tool_result', arguments: { tool_name: 'read_file', content: SECRET_BLOB } } });
    const out1 = JSON.parse(r1.result.content[0].text);
    assert.equal(out1.safe_to_ingest, true);
    assertNoRawSecrets(out1.sanitized_content, 'check_tool_result sanitized_content');
    assertNoRawSecrets(r1.result.content[0].text, 'check_tool_result full response');

    const r2 = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_tool_call', arguments: { tool_name: 'http_post', arguments: { url: 'https://example.com/hook', headers: { Authorization: FAKE.github }, body: DB_URL } } } });
    const out2 = JSON.parse(r2.result.content[0].text);
    assert.ok(out2.secrets_redacted >= 2);
    assertNoRawSecrets(JSON.stringify(out2.sanitized_arguments), 'check_tool_call sanitized_arguments');

    assert.equal(hits.length, 0, 'tool results / tool-call args must never reach the network');

    const r3 = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'analyze_prompt', arguments: { text: `Review this: AWS_ACCESS_KEY_ID=${FAKE.aws}` } } });
    assert.ok(r3.result);
    assert.equal(hits.length, 1, 'analyze_prompt with ZN_CLOUD=1 makes exactly one request');
    assertNoRawSecrets(hits[0], 'analyze_prompt upload');
    assert.ok(hits[0].includes('[REDACTED_AWS_KEY]'));

    const r4 = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'zn_status', arguments: {} } });
    const st = JSON.parse(r4.result.content[0].text);
    assert.equal(st.cloud_enabled, true);
  } finally {
    child.kill();
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('(e2e) MCP server with ZN_API_KEY but no ZN_CLOUD: analyze_prompt sends nothing', async () => {
  const { srv, hits, url } = await startCountingServer();
  const { env, home } = childEnv({ ZN_API_KEY: FAKE.apiKey, ZN_API_URL: url });
  delete env.ZN_CLOUD;
  const child = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const call = rpcSession(child);
  try {
    await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'analyze_prompt', arguments: { text: 'Summarize the attached design doc.' } } });
    const r = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'zn_status', arguments: {} } });
    const st = JSON.parse(r.result.content[0].text);
    assert.equal(st.cloud_enabled, false);
    assert.equal(st.leaves_machine, 'nothing');
    assert.equal(hits.length, 0);
  } finally {
    child.kill();
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('(e2e) shield proxy with ZN_API_KEY + ZN_CLOUD=1: wrapped tool output is forwarded redacted, nothing sent to the network', async () => {
  const { srv, hits, url } = await startCountingServer();
  const { env, home } = childEnv({ ZN_API_KEY: FAKE.apiKey, ZN_CLOUD: '1', ZN_API_URL: url });
  const dummy = path.join(home, 'dummy_server.js');
  fs.writeFileSync(
    dummy,
    `const rl = require('readline').createInterface({ input: process.stdin });
     const BLOB = ${JSON.stringify(SECRET_BLOB)};
     rl.on('line', (l) => { const m = JSON.parse(l);
       process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: BLOB }] } }) + '\\n'); });`
  );
  const child = spawn(process.execPath, [CLI, 'shield', '--', process.execPath, dummy], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const call = rpcSession(child);
  try {
    const r = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'cat_config', arguments: { path: 'config.txt', token: FAKE.github } } });
    const text = r.result.content[0].text;
    assertNoRawSecrets(text, 'shield-forwarded tool output');
    assert.ok(text.includes('[REDACTED_AWS_KEY]'));
    assert.equal(hits.length, 0, 'shield must never call the cloud');

    const ledger = path.join(home, '.zn', 'evidence.jsonl');
    if (fs.existsSync(ledger)) {
      assertNoRawSecrets(fs.readFileSync(ledger, 'utf8'), 'local evidence ledger');
    }
  } finally {
    child.kill();
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
