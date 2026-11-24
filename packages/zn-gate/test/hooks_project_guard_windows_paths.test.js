'use strict';
process.env.ZN_STATS = 'off';

// The Windows project guard (PowerShell) runs the first zn.cmd it finds on the PATH. It must not run one that lives inside the folder the
// agent runs in (the project) or inside a node_modules folder, however the PATH names it: an absolute folder of the project, a junction
// that points into the project or into node_modules\.bin, or a folder reached through such a junction. It must still run a zn.cmd in a
// folder that is only reached through a junction elsewhere (a Node.js version manager links its install folder like that).
// The behavior tests run on Windows (CI); on other systems the text of the script is checked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const win = process.platform === 'win32';
const skip = win ? false : 'Windows PowerShell behavior: runs on Windows only';

test('static: the PATH entries and the programs found are resolved before they are trusted (no text filter on node_modules)', () => {
  for (const [agent, e] of [['claude-code', 'PreToolUse'], ['cursor', 'beforeShellExecution'], ['gemini', 'BeforeTool'], ['copilot', 'preToolUse'], ['antigravity', undefined]]) {
    const s = launcher.projectWindowsScript(agent, e);
    assert.ok(!s.includes("-notmatch 'node_modules'"), agent + ': the literal-text filter is gone');
    for (const part of ['function zr(', 'function zs(', '.Target', '::GetCurrentDirectory()', '-band 1024']) {
      assert.ok(s.includes(part), agent + ': ' + part);
    }
    // zn.cmd and node are looked up only through the checked PATH and each program found is checked again.
    assert.ok(s.indexOf('function zs(') < s.indexOf("(zg 'zn.cmd')"), agent);
    assert.match(s, /function zg\(\$x\) \{ \$c = zf \$x; if \(\$c -and \(zs \$c\)\)/);
    assert.ok(launcher.windowsScriptCommand(s).length < 8191, agent + ': ' + launcher.windowsScriptCommand(s).length);
    assert.equal(launcher.isProjectWindowsScript(s, agent), true, agent);
    assert.equal(launcher.isProjectWindowsScriptExact(s, agent), true, agent);
  }
});

const sys32 = win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '';

function stubs(dir, marker, label) {
  fs.mkdirSync(dir, { recursive: true });
  // zn.cmd leaves a marker with its label; node.cmd only has to exist for the guard (zn.cmd here does not start Node.js).
  fs.writeFileSync(path.join(dir, 'zn.cmd'), '@echo off\r\necho ' + label + '>>"' + marker + '"\r\nexit /b 0\r\n');
  fs.writeFileSync(path.join(dir, 'node.cmd'), '@echo off\r\nexit /b 0\r\n');
}

function runGuard(cwd, pathEntries) {
  const script = launcher.projectWindowsScript('claude-code', 'PreToolUse');
  const ps = path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: [...pathEntries, sys32, path.join(sys32, 'WindowsPowerShell', 'v1.0')].join(';') },
  });
}

function fixture(t) {
  const project = tempDir(t, 'zn-winguard-proj-');
  const safe = tempDir(t, 'zn-winguard-safe-');
  const marker = path.join(safe, 'marker.txt');
  return { project, safe, marker };
}
const labels = (marker) => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean) : []);
const blocked = (r) => assert.equal(r.status, 2, 'the guard blocks (exit 2): ' + r.status + ' ' + r.stderr);

test('Windows guard: a zn.cmd in a folder outside the project runs (sanity)', { skip }, (t) => {
  const f = fixture(t);
  stubs(path.join(f.safe, 'bin'), f.marker, 'safe');
  const r = runGuard(f.project, [path.join(f.safe, 'bin')]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(labels(f.marker), ['safe']);
});

test('Windows guard: an absolute PATH folder inside the project is not trusted', { skip }, (t) => {
  const f = fixture(t);
  stubs(path.join(f.project, 'tools'), f.marker, 'project');
  const r = runGuard(f.project, [path.join(f.project, 'tools')]);
  blocked(r);
  assert.deepEqual(labels(f.marker), []);
});

test('Windows guard: the project folder first on the PATH is skipped, the safe one after it runs', { skip }, (t) => {
  const f = fixture(t);
  stubs(path.join(f.project, 'tools'), f.marker, 'project');
  stubs(path.join(f.safe, 'bin'), f.marker, 'safe');
  const r = runGuard(f.project, [path.join(f.project, 'tools'), path.join(f.safe, 'bin')]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(labels(f.marker), ['safe']);
});

test('Windows guard: a node.cmd only in the project is not used even when zn.cmd is safe', { skip }, (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.safe, 'bin'));
  fs.writeFileSync(path.join(f.safe, 'bin', 'zn.cmd'), '@echo off\r\necho safe>>"' + f.marker + '"\r\nexit /b 0\r\n');
  stubs(path.join(f.project, 'tools'), path.join(f.project, 'unused.txt'), 'project');
  const r = runGuard(f.project, [path.join(f.safe, 'bin'), path.join(f.project, 'tools')]);
  blocked(r);
  assert.deepEqual(labels(f.marker), []);
});

test('Windows guard: a node_modules folder is not trusted, in any case', { skip }, (t) => {
  const f = fixture(t);
  const nm = path.join(f.safe, 'Node_Modules', '.bin');
  stubs(nm, f.marker, 'nm');
  const r = runGuard(f.project, [nm]);
  blocked(r);
  assert.deepEqual(labels(f.marker), []);
});

test('Windows guard: a junction that points into the project is not trusted', { skip }, (t) => {
  const f = fixture(t);
  stubs(path.join(f.project, 'tools'), f.marker, 'project');
  const alias = path.join(f.safe, 'alias');
  fs.symlinkSync(path.join(f.project, 'tools'), alias, 'junction');
  const r = runGuard(f.project, [alias]);
  blocked(r);
  assert.deepEqual(labels(f.marker), []);
});

test('Windows guard: a junction that points into node_modules\\.bin is not trusted', { skip }, (t) => {
  const f = fixture(t);
  const nm = path.join(f.safe, 'pkg', 'node_modules', '.bin');
  stubs(nm, f.marker, 'nm');
  const alias = path.join(f.safe, 'alias');
  fs.symlinkSync(nm, alias, 'junction');
  const r = runGuard(f.project, [alias]);
  blocked(r);
  assert.deepEqual(labels(f.marker), []);
});

test('Windows guard: a folder reached through a junction that points into the project is not trusted', { skip }, (t) => {
  const f = fixture(t);
  stubs(path.join(f.project, 'deep', 'bin'), f.marker, 'project');
  const alias = path.join(f.safe, 'alias');
  fs.symlinkSync(f.project, alias, 'junction');
  const r = runGuard(f.project, [path.join(alias, 'deep', 'bin')]);
  blocked(r);
  assert.deepEqual(labels(f.marker), []);
});

test('Windows guard: a junction to a folder outside the project still runs (a Node.js version manager links its install folder)', { skip }, (t) => {
  const f = fixture(t);
  stubs(path.join(f.safe, 'versions', 'v22'), f.marker, 'linked');
  const alias = path.join(f.safe, 'current');
  fs.symlinkSync(path.join(f.safe, 'versions', 'v22'), alias, 'junction');
  const r = runGuard(f.project, [alias]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(labels(f.marker), ['linked']);
});
