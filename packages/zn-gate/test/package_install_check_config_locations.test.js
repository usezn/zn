'use strict';
/*
 * Private-registry guard: settings found above the working folder, in the global npm and pip configs and in
 * pnpm's files. Temp folders and environment overrides only; no network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const reg = require('../lib/package-registry');

function files(t, map) {
  const dir = tempDir(t, 'zn-reg-loc-');
  for (const [rel, text] of Object.entries(map)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}
const PRIV = 'https://npm.corp.example.invalid/';
const PIP = '[global]\nindex-url = https://pypi.corp.example.invalid/simple\n';

test('a project .npmrc above the working folder applies, up to the git root', (t) => {
  const root = files(t, { '.git/HEAD': 'ref: refs/heads/main\n', '.npmrc': '@corp:registry=' + PRIV + '\n', 'packages/app/src/x.txt': '' });
  const sub = path.join(root, 'packages', 'app', 'src');
  const none = files(t, {});
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: sub, env: {} }), true);
  // Above the git root does not count: the parent folder's .npmrc is outside the project.
  const outer = files(t, { '.npmrc': 'registry=' + PRIV + '\n', 'repo/.git/HEAD': 'x', 'repo/a/b.txt': '' });
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: path.join(outer, 'repo', 'a'), env: {} }), false);
  // The home folder also stops the walk.
  const home = files(t, { 'work/proj/x.txt': '' });
  assert.equal(reg.privateRegistry('npm', { home, cwd: path.join(home, 'work', 'proj'), env: {} }), false);
});

test('pnpm settings: workspace file at the root, user rc, .pnpmrc', (t) => {
  const none = files(t, {});
  const ws = files(t, { '.git/HEAD': 'x', 'pnpm-workspace.yaml': 'packages:\n  - "pkgs/*"\nregistry: ' + PRIV + '\n', 'pkgs/a/x.txt': '' });
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: path.join(ws, 'pkgs', 'a'), env: {} }), true, 'pnpm-workspace.yaml');
  const rc = files(t, { '.git/HEAD': 'x', '.pnpmrc': 'registry=' + PRIV + '\n' });
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: rc, env: {} }), true, '.pnpmrc');
  const xdg = files(t, { 'pnpm/rc': 'registry=' + PRIV + '\n' });
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: none, env: { XDG_CONFIG_HOME: xdg } }), true, 'XDG pnpm rc');
  const pub = files(t, { '.git/HEAD': 'x', 'pnpm-workspace.yaml': 'packages:\n  - "pkgs/*"\nregistry: https://registry.npmjs.org/\n' });
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: pub, env: {} }), false, 'public registry stays public');
});

test('the global npmrc is read from the override variables and from the default prefix', (t) => {
  const none = files(t, {});
  const g = files(t, { 'global-npmrc': 'registry=' + PRIV + '\n' });
  const file = path.join(g, 'global-npmrc');
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: none, env: { NPM_CONFIG_GLOBALCONFIG: file } }), true);
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: none, env: { npm_config_globalconfig: file } }), true);
  const prefix = files(t, { 'etc/npmrc': '@corp:registry=' + PRIV + '\n' });
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: none, env: { PREFIX: prefix } }), true, '$PREFIX/etc/npmrc');
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: none, env: { NPM_CONFIG_PREFIX: prefix } }), true);
  const empty = files(t, {});
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: none, env: { PREFIX: empty, NPM_CONFIG_GLOBALCONFIG: path.join(empty, 'nothing') } }), false);
});

test('pip: XDG_CONFIG_DIRS is a list in the platform separator; a pip.conf in its second folder applies', (t) => {
  // On Windows the list is ';'-separated and each folder starts with a drive letter and ':' (C:\...), so splitting on
  // ':' would break every entry. The temporary folders here are drive paths on Windows and POSIX paths elsewhere.
  const none = files(t, {});
  const first = files(t, {});
  const second = files(t, { 'pip/pip.conf': PIP });
  const list = [first, second].join(path.delimiter);
  if (process.platform === 'win32') {
    assert.ok(list.includes(';') && /^[A-Za-z]:\\/.test(second), 'a semicolon-separated list of drive paths: ' + list);
  }
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { XDG_CONFIG_DIRS: list } }), true, 'pip.conf in the second XDG folder');
  // Empty entries in the list are ignored, as pip does.
  const sparse = ['', first, '', second, ''].join(path.delimiter);
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { XDG_CONFIG_DIRS: sparse } }), true, 'empty entries are skipped');
});

test('pip: system configs, ProgramData, XDG dirs, venv pip.ini, project folders above the cwd', (t) => {
  const none = files(t, {});
  const pd = files(t, { 'pip/pip.ini': PIP });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { ProgramData: pd } }), true, 'ProgramData pip.ini');
  const dirs = files(t, { 'pip/pip.conf': PIP });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { XDG_CONFIG_DIRS: dirs } }), true, 'XDG_CONFIG_DIRS');
  const venv = files(t, { 'pip.ini': PIP });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { VIRTUAL_ENV: venv } }), true, 'venv pip.ini');
  const root = files(t, { '.git/HEAD': 'x', 'pip.conf': PIP, 'svc/api/x.txt': '' });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: path.join(root, 'svc', 'api'), env: {} }), true, 'project pip.conf above the cwd');
  const proj = files(t, { '.git/HEAD': 'x', 'pyproject.toml': '[[tool.uv.index]]\nurl = "https://x.example.invalid"\n', 'svc/x.txt': '' });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: path.join(proj, 'svc'), env: {} }), true, 'pyproject above the cwd');
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { PIP_INDEX_URL: 'https://x.example.invalid/simple' } }), true);
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { PIP_EXTRA_INDEX_URL: 'https://x.example.invalid/simple' } }), true);
});
