'use strict';
// MCP tool pinning: the shield pins a server's tools the first time and warns
// about, or removes, tools that change afterwards. Every test uses its own ZN_HOME.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function freshHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake MCP server whose single tool description is read from a file at each tools/list.
function writeServer(dir) {
  const server = path.join(dir, 'server.js');
  fs.writeFileSync(server, [
    "const fs = require('fs');",
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    '  const msg = JSON.parse(line);',
    "  if (msg.method === 'tools/list') {",
    "    const description = fs.readFileSync(process.argv[2], 'utf8');",
    "    const tools = [{ name: 'weather', description, inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }];",
    "    if (fs.existsSync(process.argv[2] + '.extra')) tools.push({ name: 'extra', description: 'Another tool.', inputSchema: { type: 'object' } });",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }) + '\\n');",
    "  } else if (msg.method === 'tools/call') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'sunny' }] } }) + '\\n');",
    '  }',
    '});',
    '',
  ].join('\n'));
  return server;
}

/** Run the shield around the fake server, send the messages, return the responses by id and stderr. */
function shield(home, server, descFile, messages, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'shield', '--', process.execPath, server, descFile], {
      env: { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true', ZN_STATS: 'off', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const byId = {};
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        if (line.trim()) {
          const msg = JSON.parse(line);
          byId[msg.id] = msg;
          // As a client does: the next request after the previous answer.
          if (next < messages.length) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...messages[next++] }) + '\n');
        }
      }
      if (Object.keys(byId).length === messages.length) child.kill();
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', () => resolve({ byId, stderr: err }));
    let next = 1;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...messages[0] }) + '\n');
    setTimeout(() => child.kill(), 10000).unref();
  });
}

const LIST = { id: 1, method: 'tools/list' };
const CALL = { id: 2, method: 'tools/call', params: { name: 'weather', arguments: { city: 'Lisbon' } } };

test('the first tool list is pinned; an unchanged list passes as it is', async (t) => {
  const home = freshHome(t);
  const server = writeServer(home);
  const desc = path.join(home, 'desc.txt');
  fs.writeFileSync(desc, 'Current weather for a city.');
  const first = await shield(home, server, desc, [LIST]);
  assert.strictEqual(first.byId[1].result.tools[0].description, 'Current weather for a city.');
  const pins = JSON.parse(fs.readFileSync(path.join(home, 'mcp-pins.json'), 'utf8'));
  const [server0] = Object.values(pins.servers);
  assert.deepStrictEqual(Object.keys(server0.tools), ['weather']);
  assert.ok(!JSON.stringify(pins).includes('Current weather'), 'the pins hold hashes, not tool text');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(home, 'mcp-pins.json')).mode & 0o777, 0o600);
  const again = await shield(home, server, desc, [LIST]);
  assert.strictEqual(again.byId[1].result.tools[0].description, 'Current weather for a city.');
  assert.doesNotMatch(again.stderr, /TOOLS CHANGED/);
});

test('warn mode: a changed tool keeps working, with a notice for the model and a warning', async (t) => {
  const home = freshHome(t);
  const server = writeServer(home);
  const desc = path.join(home, 'desc.txt');
  fs.writeFileSync(desc, 'Current weather for a city.');
  await shield(home, server, desc, [LIST]);
  fs.writeFileSync(desc, 'Current weather for a city, in Celsius.');
  const r = await shield(home, server, desc, [LIST, CALL]);
  assert.match(r.byId[1].result.tools[0].description, /^\[zn-gate: this tool is new or changed/);
  assert.match(r.stderr, /TOOLS CHANGED\] weather changed or appeared .* zn-gate pins approve [0-9a-f]{16}/);
  assert.strictEqual(r.byId[2].result.content[0].text, 'sunny');
});

test('block mode: a changed or new tool is removed and calls to it are refused, until approved', async (t) => {
  const home = freshHome(t);
  const server = writeServer(home);
  const desc = path.join(home, 'desc.txt');
  fs.writeFileSync(desc, 'Current weather for a city.');
  await shield(home, server, desc, [LIST]);
  fs.writeFileSync(desc, 'Changed description.');
  fs.writeFileSync(desc + '.extra', '');
  const env = { ZN_MCP_PINNING: 'block' };
  const r = await shield(home, server, desc, [LIST, CALL], env);
  assert.deepStrictEqual(r.byId[1].result.tools, []);
  assert.strictEqual(r.byId[2].result.isError, true);
  assert.match(r.byId[2].result.content[0].text, /changed since it was approved/);

  const listed = spawnSync(process.execPath, [CLI, 'pins'], { encoding: 'utf8', env: { ...process.env, ZN_HOME: home } });
  assert.match(listed.stdout, /changed or new since then: weather, extra/);
  const key = /^ {2}([0-9a-f]{16}) /m.exec(listed.stdout)[1];
  const ok = spawnSync(process.execPath, [CLI, 'pins', 'approve', key.slice(0, 6)], { encoding: 'utf8', env: { ...process.env, ZN_HOME: home } });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Approved weather, extra/);

  const after = await shield(home, server, desc, [LIST, CALL], env);
  assert.deepStrictEqual(after.byId[1].result.tools.map((x) => x.name), ['weather', 'extra']);
  assert.strictEqual(after.byId[2].result.content[0].text, 'sunny');
});

test('off mode and shadow mode leave the tool list alone', async (t) => {
  const home = freshHome(t);
  const server = writeServer(home);
  const desc = path.join(home, 'desc.txt');
  fs.writeFileSync(desc, 'One.');
  await shield(home, server, desc, [LIST]);
  fs.writeFileSync(desc, 'Two.');
  const off = await shield(home, server, desc, [LIST], { ZN_MCP_PINNING: 'off' });
  assert.strictEqual(off.byId[1].result.tools[0].description, 'Two.');
});

test('the agent hooks refuse zn-gate pins approve', () => {
  const policy = require('../lib/hooks/policy');
  for (const cmd of ['zn pins approve --all', 'npx -y zn-gate@1.7.0 pins approve 1a2b3c', 'zn-gate pins approve abc']) {
    assert.ok(policy.bashDenial(cmd), cmd);
  }
  assert.strictEqual(policy.adminCommand('zn-gate pins'), null, 'listing the pins is allowed');
});

test('pin hashes do not depend on key order', () => {
  const pins = require('../lib/mcp-pins');
  const a = { name: 'x', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } };
  const b = { inputSchema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' }, description: 'd', name: 'x' };
  assert.strictEqual(pins.toolHash(a), pins.toolHash(b));
  assert.notStrictEqual(pins.toolHash(a), pins.toolHash({ ...a, description: 'e' }));
});
