'use strict';

process.env.ZN_STATS = 'off';

// The hooks and plugins start the first `node` they find in the user's usual install folders (~/.local/bin, ~/bin,
// the Node.js version managers' folders and their Windows equivalents). An agent must not write, replace, move,
// delete or link a `node` or `zn` there, with a file tool or a shell command. Reading stays allowed.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mk = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

const home = mk('zn-nodef-');
const proj = mk('zn-nodef-proj-');
const O = { cwd: proj, home, env: {} };
const sh = (cmd, opts = O) => policy.bashDenial(cmd, opts);

const WRITE_FILES = [
  '.local/bin/node', '.local/bin/zn', 'bin/node', 'bin/zn', '.volta/bin/node', '.volta/bin/zn',
  '.nvm/versions/node/v22.1.0/bin/node', '.nvm/nvm.sh', '.fnm/aliases/default/bin/node', '.asdf/shims/node',
  '.local/share/fnm/aliases/default/bin/node', '.local/bin/node.exe',
];

for (const f of WRITE_FILES) {
  test('a file tool cannot write ' + f, () => {
    assert.match(String(policy.writeDenial(home + '/' + f, O)), /protected/);
    assert.match(String(policy.writeDenial('~/' + f, O)), /protected/);
  });
}

test('shell commands cannot write, replace, move, delete or link node and zn there', () => {
  const cmds = [
    'cp evil ~/.volta/bin/node',
    'ln -sf ./x ~/bin/zn',
    'mv ./x ~/.nvm/versions/node/v22.1.0/bin/node',
    'rm ~/.asdf/shims/node',
    'echo x > ~/.local/bin/node',
    'echo x >> $HOME/.local/bin/zn',
    'printf x | tee ~/.local/bin/node',
    'install -m755 evil ~/.local/bin/node',
    'chmod +x ~/bin/zn',
    'cd ~/.local/bin && cp ../evil node',
    'sed -i s/a/b/ ~/.nvm/nvm.sh',
    'mv ~/.volta ~/volta.old',
    'cp ./node ~/.local/bin/',
  ];
  for (const c of cmds) assert.match(String(sh(c)), /protected/, c);
});

test('reading those folders and unrelated files still works', () => {
  const ok = [
    'ls ~/.local/bin', 'ls -la ~/bin', 'cat ~/.nvm/nvm.sh', 'cat ~/.volta/bin/node', 'ls ~/.asdf/shims',
    'echo hi > ~/notes.txt', 'cp a.txt ~/.local/share/other.txt', 'echo x > ~/.local/bin/mytool', 'cp tool ~/bin/mytool',
    'mkdir -p bin && echo x > bin/node', 'cp evil ./bin/node', 'echo x > ~/.local/state/x.log',
  ];
  for (const c of ok) assert.equal(sh(c), null, c);
  assert.equal(policy.writeDenial(home + '/.local/bin/mytool', O), null);
  assert.equal(policy.writeDenial(proj + '/bin/node', O), null);
  assert.equal(policy.writeDenial(home + '/notes.txt', O), null);
  assert.equal(policy.readDenial(home + '/.local/bin/node', O), null);
});

test('the folders named by the environment are protected', () => {
  const env = { NVM_DIR: home + '/custom-nvm', VOLTA_HOME: home + '/vh' };
  assert.match(String(policy.writeDenial(home + '/custom-nvm/versions/node/v20/bin/node', { ...O, env })), /protected/);
  assert.match(String(policy.writeDenial(home + '/vh/bin/node', { ...O, env })), /protected/);
});

test('Windows per-user folders are protected', () => {
  const REAL_WIN = process.platform === 'win32';
  const L = (p) => (REAL_WIN ? 'C:' + p.split('/').join(String.fromCharCode(92)) : p);
  const h = L('/Users/alice');
  const env = { APPDATA: L('/Users/alice/AppData/Roaming'), LOCALAPPDATA: L('/Users/alice/AppData/Local'), NVM_HOME: L('/nvm4w/nvm'), NVM_SYMLINK: L('/nvm4w/nodejs') };
  const o = { cwd: L('/Users/alice/proj'), home: h, env };
  asWindows(() => {
    for (const f of [
      '/Users/alice/AppData/Roaming/npm/node.exe', '/Users/alice/AppData/Roaming/npm/zn.cmd', '/Users/alice/AppData/Local/Volta/bin/node.exe',
      '/nvm4w/nvm/v22.1.0/node.exe', '/nvm4w/nodejs/node.exe', '/Users/alice/AppData/Local/fnm_multishells/1234/node.exe',
      '/Users/alice/scoop/shims/node.exe', '/Users/alice/scoop/apps/nodejs/current/node.exe', '/USERS/ALICE/appdata/roaming/NPM/NODE.EXE',
    ]) {
      assert.match(String(policy.writeDenial(L(f), o)), /protected/, f);
    }
    // npm's folder holds other tools too; reading, other files and the project stay open.
    assert.equal(policy.writeDenial(L('/Users/alice/AppData/Roaming/npm/prettier.cmd'), o), null);
    assert.equal(policy.writeDenial(L('/Users/alice/AppData/Roaming/notes.txt'), o), null);
    assert.equal(policy.readDenial(L('/Users/alice/AppData/Roaming/npm/node.exe'), o), null);
    assert.equal(policy.writeDenial(L('/Users/alice/proj/bin/node.exe'), o), null);
  });
});

test.after(() => {
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
});
