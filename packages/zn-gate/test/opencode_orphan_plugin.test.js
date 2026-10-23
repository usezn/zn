'use strict';

// OpenCode plugin left behind after zn-gate was removed: it says so and how to fix it, and still blocks.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const opencode = require('../lib/agents/opencode');
const { tempDir } = require('./helpers/tmp');

async function load(t, opts) {
  const dir = tempDir(t, 'zn-oc-orphan-');
  const mjs = path.join(dir, 'zn-gate.mjs');
  fs.writeFileSync(mjs, opencode.pluginSource(opts));
  const mod = await import(pathToFileURL(mjs).href);
  return mod.ZnGate({ directory: dir });
}

test('a plugin whose runner is missing blocks with a plain message and the fix', async (t) => {
  const dir = tempDir(t, 'zn-oc-gone-');
  const plugin = path.join(dir, 'plugins', 'zn-gate.js');
  const hooks = await load(t, { scope: 'user', nodePath: process.execPath, runnerPath: path.join(dir, 'removed', 'runner.js'), pluginFile: plugin });
  const expected = (m) => {
    assert.match(m, /^zn-gate is no longer installed, but its OpenCode plugin is still active/);
    assert.match(m, /reinstall zn-gate \(npm install -g zn-gate\)/);
    assert.ok(m.includes(plugin.replace(/\\/g, '/')), 'names the file to delete');
    assert.match(m, /restart OpenCode/);
    assert.doesNotMatch(m, /secret scrubber is not working/);
    return true;
  };
  await assert.rejects(hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c' }, { args: { filePath: 'a.txt' } }), (e) => expected(e.message));
  await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'ls' } }), (e) => expected(e.message));
  await assert.rejects(hooks['chat.message']({ sessionID: 's' }, { message: {}, parts: [{ type: 'text', text: 'hello' }] }), (e) => expected(e.message));
  // Output is still withheld, not passed through.
  const res = { output: 'x', metadata: { a: 'b' } };
  await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's', callID: 'c', args: {} }, res);
  assert.match(res.output, /withheld/);
});

test('a project plugin names its own file and a missing zn program gives the same message', async (t) => {
  const hooks = await load(t, { scope: 'project' });
  const saved = process.env.PATH;
  process.env.PATH = path.join(tempDir(t, 'zn-oc-empty-'));
  try {
    await assert.rejects(hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c' }, { args: { filePath: 'a.txt' } }), (e) => {
      assert.match(e.message, /^zn-gate is no longer installed/);
      assert.match(e.message, /\.opencode\/plugins\/zn-gate\.js in this project/);
      return true;
    });
  } finally {
    process.env.PATH = saved;
  }
});

test('a runner that exists but fails keeps the old message (no false "removed")', async (t) => {
  const dir = tempDir(t, 'zn-oc-broken-');
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, 'process.stdout.write("not json");\n');
  const hooks = await load(t, { scope: 'user', nodePath: process.execPath, runnerPath: runner, pluginFile: path.join(dir, 'zn-gate.js') });
  await assert.rejects(hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c' }, { args: { filePath: 'a.txt' } }), /secret scrubber is not working/);
});
