'use strict';

// zn-gate init in a temporary HOME: without a terminal it only prints the steps and changes nothing, each agent
// gets its own steps, and unknown arguments exit with 2 on the real command line.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { guide: realGuide } = require('../lib/init-guide');
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

// The final `zn-gate check` keeps its own test records under .zn; every other file must stay as it was.
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

async function runGuide(home, cwd) {
  let text = '';
  let ran = 0;
  const code = await realGuide({
    home, cwd, env: cleanEnv(home), claude: null, ancestry: () => null, temporary: false, nodeVersion: '22.0.0',
    stdin: { isTTY: false }, write: (x) => { text += x; }, run: () => { ran++; return true; }, confirm: async () => true
  });
  return { code, text, ran };
}

function runInit(home, cwd, args = []) {
  return spawnSync(process.execPath, [CLI, 'init', ...args], { cwd, env: cleanEnv(home), input: '', encoding: 'utf8', timeout: 60000 });
}

const AGENT_DIRS = {
  codex: ['.codex', /zn hooks install codex/],
  cursor: ['.cursor', /zn hooks install cursor/],
  opencode: [path.join('.config', 'opencode'), /zn hooks install opencode/],
  'claude-code': ['.claude', /\/plugin marketplace add usezn\/zn/]
};

for (const [agent, [dir, steps]] of Object.entries(AGENT_DIRS)) {
  test('init without a terminal, ' + agent + ' only: prints its steps and changes nothing', async (t) => {
    const home = tempDir(t, 'zn-init-cli-home-');
    const cwd = tempDir(t, 'zn-init-cli-cwd-');
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    const before = snapshot(home);
    const r = await runGuide(home, cwd);
    assert.equal(r.code, 1);
    assert.equal(r.ran, 0);
    assert.match(r.text, /This is not an interactive terminal, so zn only prints the steps\. Nothing was changed\./);
    assert.match(r.text, steps);
    assert.deepEqual(snapshot(home), before);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
}

test('init without a terminal and without any agent: says so and changes nothing', async (t) => {
  const home = tempDir(t, 'zn-init-cli-home-');
  const cwd = tempDir(t, 'zn-init-cli-cwd-');
  const r = await runGuide(home, cwd);
  assert.equal(r.code, 1);
  assert.match(r.text, /No supported coding agent was found/);
  assert.deepEqual(snapshot(home), []);
});

test('init with an unknown argument exits 2 before looking at any agent', (t) => {
  const home = tempDir(t, 'zn-init-cli-home-');
  const cwd = tempDir(t, 'zn-init-cli-cwd-');
  fs.mkdirSync(path.join(home, '.codex'));
  const before = snapshot(home);
  for (const a of ['--bogus', 'now', '-y']) {
    const r = runInit(home, cwd, [a]);
    assert.equal(r.status, 2, a + ': ' + r.stderr);
    assert.ok(r.stderr.startsWith('zn-gate init: unknown argument "' + a + '"'), r.stderr);
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(snapshot(home), before);
});
