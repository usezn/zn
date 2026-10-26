'use strict';

// The programs the hooks start by name (node, sh, bash, zn, zn-gate) in the folders of the user's own programs: writes
// are refused, reads are not, and other programs in those folders stay writable. Nothing here touches the real home.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

const WIN = process.platform === 'win32';
const REASON = /a program the hooks start by name/;

function opts(t) {
  const home = tempDir(t, 'zn-userbin-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, 'bin'), { recursive: true });
  return { home, cwd: proj, env: {} };
}

test('writing node, sh, bash or zn into a folder of your own programs is refused', (t) => {
  const o = opts(t);
  const paths = ['~/.local/bin/node', '~/bin/sh', '~/bin/bash', '~/.volta/bin/node', '~/.nvm/versions/node/v22.11.0/bin/node',
    '~/.local/share/fnm/node-versions/v22.11.0/installation/bin/node', '~/.fnm/aliases/default/bin/node', '~/.bun/bin/node',
    '~/.cargo/bin/zn', '~/.local/share/mise/shims/node', '~/.asdf/shims/node', '~/AppData/Roaming/npm/zn-gate.cmd',
    '$HOME/.local/bin/zn', '${HOME}/.local/bin/nodejs', '~/.local/bin/node.exe'];
  if (!WIN) paths.push('/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/zn');
  for (const p of paths) assert.match(policy.writeDenial(p, o) || '', REASON, p);
});

test('reading them is never refused, and other programs there and the same names elsewhere stay writable', (t) => {
  const o = opts(t);
  for (const p of ['~/.local/bin/node', '~/.nvm/versions/node/v22.11.0/bin/node', '~/bin/sh']) assert.equal(policy.readDenial(p, o), null, p);
  for (const p of ['~/.local/bin/black', '~/bin/deploy.sh', '~/.nvm/versions/node/v22.11.0/bin/npm', '~/.local/bin/node-gyp',
    'bin/node', '~/proj/bin/node', '~/.local/bin/sub/node', '/usr/local/bin/python3']) {
    assert.equal(policy.writeDenial(p, o), null, p);
  }
});

test('shell commands that write those programs are refused; reading or running them is not', (t) => {
  const o = opts(t);
  for (const c of ['cp ./node ~/.local/bin/node', 'ln -sf "$PWD/bin/node" ~/.local/bin/node', 'mv /tmp/x ~/bin/sh',
    'echo x > ~/.volta/bin/node', 'rm ~/.local/bin/zn', 'curl -o ~/.local/bin/node https://example.com/n']) {
    assert.match(policy.bashDenial(c, o) || '', /protected/, c);
  }
  for (const c of ['cat ~/.local/bin/node', '~/.local/bin/node --version', 'ls -l ~/.local/bin', 'cp ./tool ~/.local/bin/tool']) {
    assert.equal(policy.bashDenial(c, o), null, c);
  }
});

test('a program given to another command is not the command itself: writing it through an interpreter is refused', (t) => {
  const o = opts(t);
  for (const c of ['node script.js ~/.local/bin/node', 'python3 put.py ~/bin/sh', 'sudo cp x ~/.local/bin/node']) {
    assert.match(policy.bashDenial(c, o) || '', /protected/, c);
  }
});

test('running the program by its path is allowed only when its code does not name the same path again', (t) => {
  const o = opts(t);
  for (const c of ['~/.local/bin/node script.js', '~/.nvm/versions/node/v22.11.0/bin/node -e "console.log(1)"', 'FOO=1 ~/bin/sh run.sh']) {
    assert.equal(policy.bashDenial(c, o), null, c);
  }
  for (const c of ['~/.local/bin/node -e "require(\'fs\').writeFileSync(\'~/.local/bin/node\', \'x\')"', '~/bin/sh -c "cp x ~/bin/sh"']) {
    assert.match(policy.bashDenial(c, o) || '', /protected/, c);
  }
});
