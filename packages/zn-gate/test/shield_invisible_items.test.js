'use strict';

process.env.ZN_STATS = 'off';

// A tools/call result whose invisible characters are split over many small items is still blocked as a whole.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== 'tools/call') return;
  const name = msg.params.name;
  let content;
  if (name === 'split') content = Array.from({ length: 60 }, () => ({ type: 'text', text: '\\u200b'.repeat(65535) }));
  else if (name === 'split_mixed') content = Array.from({ length: 60 }, () => ({ type: 'text', text: 'ok '.repeat(10) + '\\u200b'.repeat(65000) }));
  else if (name === 'resources') content = Array.from({ length: 60 }, () => ({ type: 'resource', resource: { uri: 'file:///x', text: '\\u200b'.repeat(65535) } }));
  else content = Array.from({ length: 60 }, (_, i) => ({ type: 'text', text: 'Line ' + i + ': weather is fine.' }));
  const result = { content };
  if (name === 'structured') result.structuredContent = { parts: Array.from({ length: 60 }, () => '\\u200b'.repeat(65535)) };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`;

function run(toolName) {
  const shieldCli = path.join(__dirname, '..', 'bin', 'cli.js');
  const dummy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-inv-items-')), 'server.js');
  fs.writeFileSync(dummy, SERVER);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-inv-home-'));
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [shieldCli, 'shield', '--', process.execPath, dummy], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: '' },
    });
    const rl = readline.createInterface({ input: proc.stdout });
    const t0 = Date.now();
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 30000);
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== 7) return;
      clearTimeout(timer);
      proc.kill();
      fs.rmSync(path.dirname(dummy), { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ msg, ms: Date.now() - t0 });
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: toolName, arguments: {} } }) + '\n');
  });
}

for (const name of ['split', 'split_mixed', 'resources', 'structured']) {
  test(`many items under the cap but over it in total are blocked (${name})`, async () => {
    const { msg, ms } = await run(name);
    assert.equal(msg.result.isError, true);
    const text = JSON.stringify(msg.result);
    assert.ok(text.includes('[zn-gate SECURITY BLOCKED]'));
    assert.ok(!text.includes('\u200b'), 'invisible characters must be removed');
    assert.ok(text.length < 100000);
    assert.ok(ms < 1200, `took ${ms} ms`);
  });
}

test('a benign result with many items passes untouched', async () => {
  const { msg } = await run('benign');
  assert.ok(!msg.result.isError);
  assert.equal(msg.result.content.length, 60);
  assert.equal(msg.result.content[3].text, 'Line 3: weather is fine.');
});
