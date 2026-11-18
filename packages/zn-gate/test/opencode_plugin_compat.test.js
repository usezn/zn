'use strict';
process.env.ZN_STATS = 'off';

// Compat check against a real OpenCode install: the V1 plugin that `zn hooks install opencode`
// writes must still load and its tool.execute.before hook must still block a call.
//
// It runs only when OpenCode is installed (on PATH, or OPENCODE_BIN) and ZN_OPENCODE_COMPAT=1,
// so a normal `npm test` skips it. Run it on a throwaway machine, never on a developer laptop:
//   npm i -g opencode-ai@<version> && ZN_OPENCODE_COMPAT=1 node --test test/opencode_plugin_compat.test.js
//
// How it works: OpenCode talks to a local mock model (OpenAI-compatible, on 127.0.0.1) that asks
// for one `read` of a fake private key path. A control run without the plugin must return the
// fake file content; a run with the plugin must return zn's denial instead. Only fake values,
// inside a temporary HOME, and no network beyond OpenCode's own install of the provider package.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const oc = require('../lib/agents/opencode');

const BIN = process.env.OPENCODE_BIN || 'opencode';
const FAKE = 'FAKE-KEY-FOR-ZN-COMPAT-TEST-NOT-A-SECRET';

function version() {
  if (process.env.ZN_OPENCODE_COMPAT !== '1') return null;
  const r = spawnSync(BIN, ['--version'], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
}
const VERSION = version();
const SKIP = VERSION ? false : 'OpenCode is not installed or ZN_OPENCODE_COMPAT is not 1';

/** A mock chat-completions server: first asks for one read, then answers "done". Records tool results. */
function startMock(readPath) {
  const toolResults = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch (_) { /* not json */ }
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      const tools = msgs.filter((m) => m && m.role === 'tool');
      tools.forEach((m) => toolResults.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      const wantTool = Array.isArray(j.tools) && j.tools.some((t) => t.function && t.function.name === 'read') && tools.length === 0;
      const call = { index: 0, id: 'call_zn_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: readPath }) } };
      const delta = wantTool ? { role: 'assistant', tool_calls: [call] } : { role: 'assistant', content: 'done' };
      const finish = wantTool ? 'tool_calls' : 'stop';
      const base = { id: 'mock-1', created: 1, model: 'm' };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: delta, finish_reason: finish }], usage }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, toolResults, port: server.address().port })));
}

function runOpenCode({ withPlugin }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-oc-compat-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const keyFile = path.join(project, '.ssh', 'id_rsa');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(keyFile, FAKE + '\n');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
  };
  const pluginFile = oc.pluginPath({ env, home, scope: 'user' });
  if (withPlugin) oc.install({ env, home, scope: 'user', mcp: false });
  return startMock(keyFile).then(({ server, toolResults, port }) => new Promise((resolve) => {
    fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      model: 'mock/m',
      small_model: 'mock/m',
      enabled_providers: ['mock'],
      autoupdate: false,
      share: 'disabled',
      permission: { read: 'allow', external_directory: 'allow', edit: 'deny', bash: 'deny', webfetch: 'deny' },
      provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'mock', options: { baseURL: 'http://127.0.0.1:' + port + '/v1', apiKey: 'x' }, models: { m: { name: 'm', tool_call: true, limit: { context: 32000, output: 4096 } } } } },
    }));
    // Inline config too: it wins over any other config source, so a real provider is never used.
    env.OPENCODE_CONFIG_CONTENT = fs.readFileSync(path.join(project, 'opencode.json'), 'utf8');
    const child = spawn(BIN, ['run', '--model', 'mock/m', 'read my key file'],{ cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill(), 240000);
    child.on('close', (code) => {
      clearTimeout(timer);
      server.close();
      resolve({ code, out, toolResults, pluginFile, root });
    });
  }));
}

test('OpenCode loads the V1 zn plugin and tool.execute.before blocks a read of a private key path', { skip: SKIP, timeout: 600000 }, async () => {
  console.log('# OpenCode version under test: ' + VERSION);
  const control = await runOpenCode({ withPlugin: false });
  const joinedControl = control.toolResults.join('\n');
  assert.ok(control.toolResults.length > 0, 'control run: the mock model never got a tool result back (provider setup broke)\n' + control.out);
  assert.ok(joinedControl.includes(FAKE), 'control run without the plugin should read the fake file\n' + joinedControl);

  const guarded = await runOpenCode({ withPlugin: true });
  assert.ok(fs.existsSync(guarded.pluginFile), 'plugin file was not written');
  const joined = guarded.toolResults.join('\n');
  assert.ok(guarded.toolResults.length > 0, 'guarded run: no tool result reached the model\n' + guarded.out);
  assert.ok(!joined.includes(FAKE), 'the fake key reached the model: the plugin did not block\n' + joined);
  assert.match(joined, /zn: .*secrets/s, 'expected the zn denial text as the tool result\n' + joined);
  for (const r of [control, guarded]) fs.rmSync(r.root, { recursive: true, force: true });
});
