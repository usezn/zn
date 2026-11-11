'use strict';
/** Docker ~/.docker/config.json: the registry auth value is masked, the registry name is kept. Fake values only. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./_harness');
const E = require('../lib/scrub/engine');

const REGISTRY = 'registry.example.com';
const AUTH = Buffer.from('user:' + 'x'.repeat(20)).toString('base64');
const BODY = JSON.stringify({ auths: { [REGISTRY]: { auth: AUTH } } });

function spansOver(text, spans) {
  return spans.map((s) => text.slice(s.start, s.end));
}

test('docker config.json: the auth value is masked and the registry name is kept', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-docker-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-docker-cwd-'));
  try {
    fs.mkdirSync(path.join(home, '.docker'), { recursive: true });
    fs.writeFileSync(path.join(home, '.docker', 'config.json'), BODY + '\n');
    const text = 'config: ' + BODY + '\n';
    // prepare() loads the local exact-value sources (credential files) that scan() reads; no vault is passed.
    const ctx = await E.prepare({ home, cwd, env: {}, exactFiles: true, destination: 'assistant', project: cwd, agent: 'test', tool: 'Read' });
    const spans = E.scan(text, ctx);
    const masked = spansOver(text, spans);
    assert.ok(masked.includes(AUTH), 'the base64 auth value is not masked: ' + JSON.stringify(masked));
    assert.ok(!spans.some((s) => text.slice(s.start, s.end).includes(REGISTRY)), 'the registry name must stay readable');
    assert.ok(!spans.some((s) => text.slice(s.start, s.end).includes('"auths"')), 'the JSON keys must stay readable');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

if (require.main === module) run('scrub docker config auth');
