'use strict';
/*
 * Install keeps the user's unrelated settings, for every adapter that edits an agent config file: a top-level
 * setting zn does not use ("theme": "dark" in JSON) must still be there with the same value right after install.
 * Uninstall is covered by hooks_install_uninstall_roundtrip.test.js and config_keep_format.test.js; this file
 * checks the install alone. Library adapters only (getAdapter(id).install on a throwaway HOME); no CLI, no
 * terminal. Every path is inside temporary folders.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function machine(t) {
  const home = tempDir(t, 'zn-keys-home-');
  const cwd = tempDir(t, 'zn-keys-cwd-');
  return { home, cwd, env: { HOME: home, USERPROFILE: home, PATH: '' } };
}

function call(m, id, fn, scope) {
  return getAdapter(id)[fn]({ scope, projectDir: m.cwd, home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
}

// The user-scope file the adapter edits, relative to HOME: found by installing on a scratch machine (as the roundtrip test does).
function target(t, id) {
  const probe = machine(t);
  return path.relative(probe.home, call(probe, id, 'install', 'user').settings);
}

function seed(m, rel, text) {
  const file = path.join(m.home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// JSON config files. Cursor and Copilot carry "version": 1 at the top, which their install requires.
const JSON_DOCS = {
  cursor: { version: 1, theme: 'dark' },
  copilot: { version: 1, theme: 'dark' },
  antigravity: { theme: 'dark' },
  zcode: { theme: 'dark' },
};

for (const [id, doc] of Object.entries(JSON_DOCS)) {
  test(`install keeps unrelated settings: ${id}: the top-level "theme": "dark" in its JSON config is still there after install`, (t) => {
    const m = machine(t);
    const file = seed(m, target(t, id), JSON.stringify(doc, null, 2) + '\n');
    call(m, id, 'install', 'user');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.theme, 'dark');
    assert.notDeepEqual(after, doc, 'the install wrote its hooks');
  });
}

// Codex keeps its hooks in hooks.json, a separate JSON file. Its config.toml (TOML) is not written by install
// (the install only prints a note about the secrets MCP server), so that file must come out byte for byte.
test('install keeps unrelated settings: codex: its hooks.json keeps "theme": "dark", and config.toml (TOML) is not written at all', (t) => {
  const m = machine(t);
  const hooks = seed(m, path.join('.codex', 'hooks.json'), JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
  const tomlText = 'model = "x"\n';
  const toml = seed(m, path.join('.codex', 'config.toml'), tomlText);
  call(m, 'codex', 'install', 'user');
  assert.equal(JSON.parse(fs.readFileSync(hooks, 'utf8')).theme, 'dark');
  assert.equal(fs.readFileSync(toml, 'utf8'), tomlText);
});
