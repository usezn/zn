'use strict';

// zn hooks install claude-code with an npm-installed Claude Code on Windows: `claude` is claude.cmd, which only
// runs through cmd.exe. zn registers its "secrets" MCP server by running claude.cmd through the system cmd.exe
// (every argument double-quoted; refused when an argument holds a cmd.exe metacharacter), and when it cannot, it
// prints a short command with the stable zn-gate path (never the npx cache). Nothing real is started: spawn and
// cmd.exe are stand-ins, and everything runs in a temporary home.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');
const CMD = 'C:/Users/Ana Garcia/AppData/Roaming/npm/claude.cmd';
const NODE = 'C:/Program Files/nodejs/node.exe';
const CLI = 'C:/Users/Ana Garcia/.zn/runtime/1.0.0/zn-gate/bin/cli.js';
const SYSTEM_CMD = 'C:/Windows/System32/cmd.exe';

function fakeSpawn(status = 0, stderr = '') {
  const calls = [];
  const fn = (file, args, options) => { calls.push({ file, args, options }); return { status, stdout: '', stderr }; };
  return { fn, calls };
}

function base(t, extra = {}) {
  const home = tempDir(t, 'zn-b136-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn') };
  return { home, env, opts: { scope: 'user', home, env, platform: 'win32', nodePath: NODE, cliPath: CLI, runnerPath: path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js'), claudeBin: CMD, cmdExe: SYSTEM_CMD, ...extra } };
}

test('claude.cmd: the MCP server is registered through the system cmd.exe, every argument double-quoted', (t) => {
  const spy = fakeSpawn();
  const { opts } = base(t, { spawnSync: spy.fn });
  const r = claude.install(opts);
  assert.equal(r.mcp, 'claude mcp (user scope)');
  assert.deepEqual(r.warnings.filter((w) => /claude/.test(w)), []);
  assert.equal(spy.calls.length, 1);
  const c = spy.calls[0];
  assert.equal(c.file, SYSTEM_CMD);
  assert.equal(c.options.windowsVerbatimArguments, true);
  assert.equal(c.options.shell, undefined, 'no shell: option, the line is built by zn');
  assert.deepEqual(c.args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  assert.equal(c.args[4], '"' + [CMD, 'mcp', 'add', '--scope', 'user', 'secrets', '--', NODE, CLI, 'secrets-mcp', '--agent', 'claude-code'].map((a) => '"' + a + '"').join(' ') + '"');
});

test('claude.cmd: a path with a cmd.exe metacharacter is refused, and a short command with the stable path is printed', (t) => {
  const spy = fakeSpawn();
  const { opts } = base(t, { spawnSync: spy.fn, cliPath: 'C:/Users/a & b/.zn/runtime/1.0.0/zn-gate/bin/cli.js' });
  const r = claude.install(opts);
  assert.equal(spy.calls.length, 0, 'claude.cmd was not started');
  assert.equal(r.mcp, undefined);
  const w = r.warnings.find((x) => /batch file \(claude\.cmd\)/.test(x));
  assert.ok(w, JSON.stringify(r.warnings));
  assert.ok(w.includes('claude mcp add --scope user secrets -- "' + NODE + '" "C:/Users/a & b/.zn/runtime/1.0.0/zn-gate/bin/cli.js" "secrets-mcp" "--agent" "claude-code"'), w);
  assert.doesNotMatch(w, /_npx/);
});

test('claude.cmd: a failing registration is reported with the same short command', (t) => {
  const spy = fakeSpawn(1, 'something went wrong');
  const { opts } = base(t, { spawnSync: spy.fn });
  const r = claude.install(opts);
  assert.equal(r.mcp, undefined);
  const w = r.warnings.find((x) => /`claude mcp add` failed \(something went wrong\)/.test(x));
  assert.ok(w, JSON.stringify(r.warnings));
  assert.match(w, /register the MCP server yourself with: claude mcp add --scope user secrets -- "C:\/Program Files\/nodejs\/node\.exe" /);
});

test('claude.exe (not a batch file) keeps the add-json call, started directly', (t) => {
  const spy = fakeSpawn();
  const { opts } = base(t, { spawnSync: spy.fn, claudeBin: 'C:/Users/Ana Garcia/.local/bin/claude.exe' });
  const r = claude.install(opts);
  assert.equal(r.mcp, 'claude mcp (user scope)');
  assert.equal(spy.calls[0].file, 'C:/Users/Ana Garcia/.local/bin/claude.exe');
  assert.deepEqual(spy.calls[0].args.slice(0, 5), ['mcp', 'add-json', '--scope', 'user', 'secrets']);
});

test('claude.cmd: uninstall removes zn\'s own server through cmd.exe too', (t) => {
  const spy = fakeSpawn();
  const { home, env, opts } = base(t, { spawnSync: spy.fn });
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: { secrets: { command: NODE, args: [CLI, 'secrets-mcp', '--agent', 'claude-code'] } } }));
  const r = claude.uninstall({ ...opts, home });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].file, SYSTEM_CMD);
  assert.equal(spy.calls[0].args[4], '"' + [CMD, 'mcp', 'remove', '--scope', 'user', 'secrets'].map((a) => '"' + a + '"').join(' ') + '"');
  assert.deepEqual(r.warnings, []);
});

test('the MCP server runs the stable copy of zn-gate, never the npx cache', (t) => {
  // A copy of the package where npx puts it, loaded the way npx runs it.
  const cache = tempDir(t, 'zn-b136-npx-');
  const root = path.join(cache, '_npx', 'abc123', 'node_modules', 'zn-gate');
  const pkg = path.join(__dirname, '..');
  fs.mkdirSync(root, { recursive: true });
  for (const n of ['bin', 'lib', 'package.json', 'node_modules']) if (fs.existsSync(path.join(pkg, n))) fs.cpSync(path.join(pkg, n), path.join(root, n), { recursive: true });
  const adapter = require(path.join(root, 'lib', 'agents', 'claude-code.js'));
  const spy = fakeSpawn();
  const home = tempDir(t, 'zn-b136-home-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn') };
  const r = adapter.install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: path.join(root, 'lib', 'hooks', 'runner.js'), claudeBin: '/usr/bin/claude', spawnSync: spy.fn });
  assert.equal(r.mcp, 'claude mcp (user scope)');
  const conf = JSON.parse(spy.calls[0].args[5]);
  assert.ok(conf.args[0].startsWith(path.join(home, '.zn', 'runtime')), conf.args[0]);
  assert.ok(conf.args[0].endsWith(path.join('zn-gate', 'bin', 'cli.js')), conf.args[0]);
  assert.ok(fs.existsSync(conf.args[0]), 'the copy has the cli');
  assert.doesNotMatch(conf.args[0], /_npx/);
});
