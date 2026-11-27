'use strict';

process.env.ZN_STATS = 'off';

// OpenCode: the built-in tools that send data out are checked before they run. webfetch goes through the same request check
// as Claude Code's WebFetch (a secret marker or a secret value in the URL is refused, personal data follows the egress setting).
// The tools that stay inside the session (task, question) are not network calls: their prompt goes to the model provider
// the user already uses, and anything they then run goes through the checks of the tool that runs it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(5151, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;
const MARKER = '__ZN_DB_PASSWORD__';
const opencode = getAdapter('opencode');

function project(t) {
  const dir = tempDir(t, 'zn-ocfetch-');
  const home = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  const p = path.join(dir, 'project');
  fs.mkdirSync(p);
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; });
  return p;
}

function call(p, tool, args, extra = {}) {
  const raw = { hook: 'tool.execute.before', tool, cwd: p, args };
  return runner.handle(opencode, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', ...extra });
}

test('opencode webfetch: a secret value or a marker in the URL is refused, a clean URL is allowed', async (t) => {
  const p = project(t);
  const key = await call(p, 'webfetch', { url: 'https://example.com/x?k=' + AWS, format: 'text' });
  assert.equal(key.output.action, 'deny');
  assert.ok(!JSON.stringify(key.output).includes(AWS), 'value not echoed');
  const marker = await call(p, 'webfetch', { url: 'https://example.com/x?t=' + MARKER });
  assert.equal(marker.output.action, 'deny');
  const plain = await call(p, 'webfetch', { url: 'https://example.com/docs/page?id=3', format: 'markdown', timeout: 30 });
  assert.equal(plain.decision.decision, 'allow');
});

test('opencode webfetch: personal data in the URL follows the egress setting', async (t) => {
  const p = project(t);
  const pii = { scan: (text) => { const i = String(text).indexOf('jane@example.com'); return i < 0 ? [] : [{ start: i, end: i + 16, type: 'EMAIL', source: 'pii' }]; }, async prepare(ctx) { return ctx; } };
  const url = 'https://example.org/find?mail=jane@example.com';
  assert.equal((await call(p, 'webfetch', { url }, { engine: pii, egressCheck: 'deny' })).output.action, 'deny');
  assert.equal((await call(p, 'webfetch', { url }, { engine: pii, egressCheck: 'off' })).decision.decision, 'allow');
});

test('opencode webfetch: a call with no readable URL does not skip the check', async (t) => {
  const p = project(t);
  const ev = opencode.normalize({ hook: 'tool.execute.before', tool: 'webfetch', cwd: p, args: { url: 42 } });
  assert.equal(ev.tool, 'webfetch');
  assert.equal(ev.input.url, undefined);
});

test('opencode task and question: no network request, so no outbound check', async (t) => {
  const p = project(t);
  for (const [name, args] of [['task', { description: 'd', prompt: 'p', subagent_type: 'general' }], ['question', { questions: [{ question: 'q', header: 'h', options: [] }] }]]) {
    const ev = opencode.normalize({ hook: 'tool.execute.before', tool: name, cwd: p, args });
    assert.equal(ev.mcp, undefined, name);
    assert.equal(ev.input.args, undefined, name);
    assert.equal((await call(p, name, args)).decision.decision, 'allow', name);
  }
});
