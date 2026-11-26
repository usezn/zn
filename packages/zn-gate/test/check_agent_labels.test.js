'use strict';
// The agent names that `zn-gate check`, `zn-gate init` and `zn reach` print all come from check():
// init-guide.js and reach/index.js read `name` from its results. This pins the names the docs quote.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check } = require('../lib/check');

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-labels-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('check lists Copilot CLI and Gemini CLI as experimental', async (t) => {
  const home = tmpdir(t);
  const cwd = tmpdir(t);
  const { results } = await check({ home, env: { HOME: home, PATH: '' }, cwd, live: false });
  const byId = Object.fromEntries(results.map((r) => [r.id, r.name]));
  assert.strictEqual(byId.copilot, 'Copilot CLI (experimental)');
  assert.strictEqual(byId.gemini, 'Gemini CLI (experimental)');
  for (const r of results) assert.notStrictEqual(r.name, 'GitHub Copilot (VS Code, CLI)');
});

test('zn reach takes the agent names from check', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reach', 'index.js'), 'utf8');
  assert.match(src, /require\('\.\.\/check'\)/);
  assert.match(src, /name: r\.name/);
});

test('zn-gate init takes the agent names from check', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'init-guide.js'), 'utf8');
  assert.match(src, /require\('\.\/check'\)/);
  assert.match(src, /\$\{i\.name\.padEnd\(12\)\} not found on this machine/);
});
