'use strict';
process.env.ZN_STATS = 'off';

// The project hook guard runs the `zn` it finds on the PATH. A package can plant a `zn` in node_modules/.bin, and
// `npm run` or direnv put that folder on the PATH as an absolute entry: the guard must not run it (it blocks instead).
// Static: the planted zn only writes a marker file; nothing destructive is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const launcher = require('../lib/agents/launcher');
const opencode = require('../lib/agents/opencode');
const { tempDir } = require('./helpers/tmp');

const skip = { skip: process.platform === 'win32' };
const shellArgs = (sh) => (/(^|\/)bash$/.test(sh) ? ['--norc', '--noprofile'] : []);

function whichSh() {
  for (const d of String(process.env.PATH || '').split(':')) {
    const f = path.join(d, 'sh');
    if (d && fs.existsSync(f)) return fs.realpathSync(f);
  }
  return '/bin/sh';
}

/* <root>/<sub> holds sh, node and a zn that writes a marker and exits 0 (an answer the guard would take as done). */
function mkbin(t, sub) {
  const root = tempDir(t, 'zn-guard-nm-');
  const bin = path.join(root, sub);
  fs.mkdirSync(bin, { recursive: true });
  const marker = path.join(root, 'marker');
  fs.symlinkSync(whichSh(), path.join(bin, 'sh'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'zn'), '#!' + whichSh() + '\necho planted > ' + marker + '\nexit 0\n');
  fs.chmodSync(path.join(bin, 'zn'), 0o755);
  return { bin, marker };
}

const forms = {
  'sh -c (agents that run a shell)': (bin, input) => {
    const cmd = launcher.projectShCommand('claude-code', 'PreToolUse');
    assert.ok(cmd.startsWith('sh -c '));
    const script = cmd.slice(6).replace(/^'|'$/g, '').replace(/'\''/g, "'");
    return spawnSync(path.join(bin, 'sh'), [...shellArgs(whichSh()), '-c', script], { input, encoding: 'utf8', env: { PATH: bin + ':/usr/bin:/bin' }, cwd: '/' });
  },
  'split-on-spaces form (Antigravity)': (bin, input) => {
    const parts = launcher.projectShCommand('antigravity').split(' ');
    return spawnSync(path.join(bin, parts[0]), parts.slice(1), { input, encoding: 'utf8', env: { PATH: bin + ':/usr/bin:/bin' }, cwd: '/' });
  },
};

for (const [name, run] of Object.entries(forms)) {
  test('project guard, ' + name + ': a zn in a node_modules folder on the PATH is not run', skip, (t) => {
    const { bin, marker } = mkbin(t, path.join('node_modules', '.bin'));
    const r = run(bin, '{}');
    assert.equal(fs.existsSync(marker), false, 'the planted zn ran');
    assert.notEqual(r.status === 0 && fs.existsSync(marker), true);
  });
  test('project guard, ' + name + ': the same zn outside node_modules is still run (control)', skip, (t) => {
    const { bin, marker } = mkbin(t, 'bin');
    run(bin, '{}');
    assert.equal(fs.existsSync(marker), true, 'the guard no longer runs zn at all');
  });
}

test('project guard, PowerShell form: PATH entries in node_modules are dropped before zn.cmd and node are looked for', () => {
  const s = launcher.projectWindowsScript('claude-code', 'PreToolUse');
  // Not a text filter any more: each PATH entry and each program found is resolved, links followed, and checked (see
  // hooks_project_guard_windows_paths.test.js for the behavior on Windows).
  const drop = s.indexOf("\\node_modules\\'");
  assert.ok(drop > 0, 'no node_modules check');
  assert.ok(s.indexOf('function zs(') < drop);
  assert.ok(drop < s.indexOf("(zg 'zn.cmd')"), 'the check comes before the lookup');
  assert.ok(s.indexOf('function zf') < s.indexOf('function zg'));
});

test('OpenCode project plugin: the PATH given to zn has no node_modules entry', () => {
  const src = opencode.pluginSource({ scope: 'project' });
  assert.match(src, /\/node_modules\/i\.test\(d\)/);
  const m = src.match(/function projectEnv\(\) \{[\s\S]*?\n\}\n/)[0];
  const env = new Function('process', 'realpathSync', 'existsSync', 'homedir', m + '; return projectEnv();')({
    platform: 'linux',
    cwd: () => '/',
    env: { PATH: '/proj/node_modules/.bin:/usr/bin:/opt/Node_Modules/x/bin:/bin' },
  }, (p) => p, () => false, () => '/nonexistent-home');
  assert.equal(env.PATH, '/usr/bin:/bin');
});
