'use strict';

// getKnownEnvironments: config path of each agent per platform, with fake
// HOME, XDG_CONFIG_HOME, APPDATA and CODEX_HOME values.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getKnownEnvironments } = require('../lib/init');

const VARS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'CODEX_HOME'];

function run(platform, env, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-known-env-'));
  const saved = {};
  for (const k of VARS) saved[k] = process.env[k];
  const platDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const cwd = process.cwd();
  try {
    for (const k of VARS) delete process.env[k];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const [k, v] of Object.entries(env(home))) process.env[k] = v;
    Object.defineProperty(process, 'platform', { value: platform });
    return fn(home);
  } finally {
    Object.defineProperty(process, 'platform', platDesc);
    process.chdir(cwd);
    for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function byId(envs, id) {
  const e = envs.find((x) => x.id === id);
  assert.ok(e, `missing ${id}`);
  return e;
}

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`known environments on ${platform}: config path of each agent`, () => {
    run(platform, (home) => ({
      XDG_CONFIG_HOME: path.join(home, 'xdg'),
      APPDATA: path.join(home, 'roaming'),
      CODEX_HOME: path.join(home, 'codex-home'),
    }), (home) => {
      const envs = getKnownEnvironments();
      const p = (id) => byId(envs, id).filePath;
      const desktop = platform === 'win32'
        ? path.join(home, 'roaming', 'Claude', 'claude_desktop_config.json')
        : platform === 'darwin'
          ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : path.join(home, 'xdg', 'Claude', 'claude_desktop_config.json');
      assert.equal(p('claude-desktop'), desktop);
      assert.equal(p('claude-code'), path.join(home, '.claude.json'));
      assert.equal(p('cursor'), path.join(home, '.cursor', 'mcp.json'));
      assert.equal(p('antigravity'), path.join(home, '.gemini', 'antigravity', 'mcp_config.json'));
      assert.equal(p('antigravity-shared'), path.join(home, '.gemini', 'config', 'mcp_config.json'));
      assert.equal(p('antigravity-project'), path.join(process.cwd(), '.agents', 'mcp_config.json'));
      assert.equal(p('codex'), path.join(home, 'codex-home', 'config.toml'));
      assert.equal(p('opencode'), path.join(home, 'xdg', 'opencode', 'opencode.json'));
      assert.equal(p('hermes-piagent'), path.join(home, '.hermes', 'mcp.json'));
    });
  });
}

test('Windows: Claude Desktop falls back to AppData/Roaming without APPDATA', () => {
  run('win32', () => ({}), (home) => {
    assert.equal(
      byId(getKnownEnvironments(), 'claude-desktop').filePath,
      path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    );
  });
});

test('Codex falls back to ~/.codex when CODEX_HOME is unset or empty', () => {
  for (const value of [undefined, '']) {
    run('linux', () => (value === undefined ? {} : { CODEX_HOME: value }), (home) => {
      assert.equal(byId(getKnownEnvironments(), 'codex').filePath, path.join(home, '.codex', 'config.toml'));
    });
  }
});

test('empty XDG_CONFIG_HOME falls back to ~/.config', () => {
  run('linux', () => ({ XDG_CONFIG_HOME: '' }), (home) => {
    const envs = getKnownEnvironments();
    assert.equal(byId(envs, 'opencode').filePath, path.join(home, '.config', 'opencode', 'opencode.json'));
    assert.equal(byId(envs, 'claude-desktop').filePath, path.join(home, '.config', 'Claude', 'claude_desktop_config.json'));
  });
});

test('OpenCode: opencode.jsonc is used only when opencode.json is missing', () => {
  run('linux', (home) => ({ XDG_CONFIG_HOME: path.join(home, 'xdg') }), (home) => {
    const dir = path.join(home, 'xdg', 'opencode');
    const json = path.join(dir, 'opencode.json');
    const jsonc = path.join(dir, 'opencode.jsonc');
    const opencode = () => byId(getKnownEnvironments(), 'opencode').filePath;

    assert.equal(opencode(), json, 'neither file exists');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jsonc, '{}');
    assert.equal(opencode(), jsonc, 'only jsonc exists');
    fs.writeFileSync(json, '{}');
    assert.equal(opencode(), json, 'both exist');
    fs.rmSync(jsonc);
    assert.equal(opencode(), json, 'only json exists');
  });
});
