'use strict';

// zn-gate init --wrap-mcp refuses an unknown argument with exit 2 before it reads or writes any agent config, so a
// misspelt --dry-run cannot wrap the real MCP servers. The valid options still work.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { AGENT_ENV_VARS } = require('../lib/broker/tty');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function cleanEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), ZN_STATS: 'off' };
  for (const v of AGENT_ENV_VARS) delete env[v];
  // No program is found on PATH, so no step can start anything.
  env.PATH = '';
  return env;
}

// Every file under the home, with its content. The zn-gate state folder is skipped.
function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === path.join(dir, '.zn')) continue;
      if (e.isDirectory()) { out.push(p + '/'); walk(p); } else out.push(p + ':' + fs.readFileSync(p, 'utf8'));
    }
  })(dir);
  return out.sort();
}

// A Cursor MCP config with one server that wrapping would change.
function setUpHome(t) {
  const home = tempDir(t, 'zn-init-wrap-home-');
  const cwd = tempDir(t, 'zn-init-wrap-cwd-');
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['server.js'] } } }, null, 2) + '\n');
  return { home, cwd };
}

function runInit(home, cwd, args) {
  return spawnSync(process.execPath, [CLI, 'init', ...args], { cwd, env: cleanEnv(home), input: '', encoding: 'utf8', timeout: 60000 });
}

test('init --wrap-mcp with a misspelt --dry-run exits 2 and changes no file', (t) => {
  const { home, cwd } = setUpHome(t);
  const before = snapshot(home);
  const r = runInit(home, cwd, ['--wrap-mcp', '--dryrun']);
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.startsWith('zn-gate init: unknown argument "--dryrun"'), r.stderr);
  assert.match(r.stderr, /zn-gate init --wrap-mcp/);
  assert.equal(r.stdout, '');
  assert.deepEqual(snapshot(home), before);
});

test('init --wrap-mcp refuses any unknown argument, wherever it is, and changes nothing', (t) => {
  const { home, cwd } = setUpHome(t);
  const before = snapshot(home);
  for (const args of [['--wrap-mcp', '--bogus'], ['--wrap-mcp', '--dry-run', 'now'], ['--dry-run', '-y', '--shadow'], ['--revert', '--Dry-Run']]) {
    const r = runInit(home, cwd, args);
    const bad = args.find((a) => !['--wrap-mcp', '--dry-run', '--shadow', '--revert'].includes(a));
    assert.equal(r.status, 2, args.join(' ') + ': ' + r.stderr);
    assert.ok(r.stderr.startsWith('zn-gate init: unknown argument "' + bad + '"'), r.stderr);
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(snapshot(home), before);
});

test('init --wrap-mcp --dry-run still runs and changes no file', (t) => {
  const { home, cwd } = setUpHome(t);
  const before = snapshot(home);
  const r = runInit(home, cwd, ['--wrap-mcp', '--dry-run']);
  assert.notEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown argument/);
  assert.match(r.stdout, /cursor/i);
  assert.deepEqual(snapshot(home), before);
});
