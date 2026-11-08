'use strict';

// zn-gate status and the agent ids. `status` does not print the list of agents: it
// reports the rules, the engine, the key and the agent-specific warnings (managed installs,
// Claude Code and Cursor settings). So the promise tested here is that status runs cleanly
// and exits 0 with the hooks of every supported agent installed into a temporary home.
// The one place the program prints every agent id is the help text ("Install zn's hooks
// for ..."), which is checked as well. The ids come from AGENT_IDS, not a hard-coded copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { AGENT_IDS } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const BIN = path.join(__dirname, '..', 'bin', 'cli.js');

function envFor(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    ZN_HOME: path.join(home, '.zn'),
    ZN_KEYCHAIN_BACKEND: 'passphrase',
    ZN_STATS: 'off',
  };
}

function zn(home, args) {
  return spawnSync(process.execPath, [BIN, ...args], { env: envFor(home), encoding: 'utf8', cwd: home });
}

// `zn hooks install` needs an interactive terminal, so each adapter is installed through its
// own install() in a child process whose HOME is the temporary home.
const INSTALL = 'require(process.argv[1]).getAdapter(process.argv[2]).install({ scope: "user" });';

function installAgent(home, id) {
  const registry = path.join(__dirname, '..', 'lib', 'agents', 'index.js');
  return spawnSync(process.execPath, ['-e', INSTALL, registry, id], { env: envFor(home), encoding: 'utf8', cwd: home });
}

test('zn status exits 0 with the hooks of every supported agent installed', (t) => {
  assert.ok(AGENT_IDS.length > 0, 'the registry lists agents');
  const home = tempDir(t, 'zn-status-agents-');
  for (const id of AGENT_IDS) {
    const r = installAgent(home, id);
    assert.equal(r.status, 0, `install ${id} failed: ${r.stdout}${r.stderr}`);
  }
  const s = zn(home, ['status']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /zn-gate Status:/);
  assert.match(s.stdout, /Leaves machine {2}: Nothing/);
});

test('the help text names every supported agent id', (t) => {
  const home = tempDir(t, 'zn-status-help-');
  const r = zn(home, ['--help']);
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes("Install zn's hooks for"));
  assert.ok(line, 'the help text has the hooks line');
  for (const id of AGENT_IDS) assert.ok(line.includes(id), `help lists ${id}`);
});
