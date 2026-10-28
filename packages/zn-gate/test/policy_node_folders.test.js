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

// Review fixes: reading and running, own tools in the bin folders, odd environment values, parent folders.

test('reading, running, sourcing and changing into those folders is not refused', () => {
  const ok = [
    'source ~/.nvm/nvm.sh && nvm use 22',
    '. ~/.nvm/nvm.sh',
    '~/.nvm/versions/node/v22.1.0/bin/node script.js',
    '~/.local/bin/node --version',
    '$HOME/.volta/bin/node -e "console.log(1)"',
    'cp ~/.local/bin/node /tmp/nodecopy',
    'cd ~/.local/bin && ls',
    'cd ~/.nvm && cat nvm.sh',
    'cat ~/.local/bin/zn | head -1',
  ];
  for (const c of ok) assert.equal(sh(c), null, c);
});

test('own tools can be installed in the bin folders; only node and zn names and the folder itself are refused', () => {
  const ok = [
    'mkdir -p ~/.local/bin',
    'mkdir -p ~/bin',
    'cp target/release/mytool ~/.local/bin/',
    'install -m755 build/tool ~/.local/bin/',
    'tar -C ~/.local/bin -xzf tool.tgz',
    'mkdir -p ~/bin && cp scripts/deploy.sh ~/bin/',
    'cp -t ~/.local/bin ./mytool',
    'ln -s ./mytool ~/.local/bin/mytool',
    'install -d ~/.local/bin',
  ];
  for (const c of ok) assert.equal(sh(c), null, c);
  const bad = [
    'rm -rf ~/.local/bin',
    'mv ~/bin ~/bin.old',
    'ln -sfn ~/other ~/.local/bin',
    'cp ./node ~/.local/bin/',
    'install -m755 ./zn ~/bin/',
    'cp -t ~/.local/bin ./node',
    'cp ./build/zn.exe ~/.local/bin',
    'mv ./x ~/.local/bin/node',
    'sudo cp evil ~/.local/bin/node',
    'tar -C ~/.nvm -xzf x.tgz',
    'curl -o ~/.local/bin/node https://example.com/node',
    'dd if=evil of=~/bin/zn',
    'find ~/.nvm -delete',
    "python3 -c \"open('" + home + "/.local/bin/node','w').write('x')\"",
  ];
  for (const c of bad) assert.match(String(sh(c)), /protected|zn:/, c);
});

test('an environment value that is relative, the home folder, the project or a system folder is ignored', () => {
  const values = ['.', '..', 'tools', home, home + '/', proj, require('node:path').dirname(proj), '/', '/usr', '/opt', ''];
  for (const name of ['N_PREFIX', 'NVM_DIR', 'ASDF_DATA_DIR', 'VOLTA_HOME', 'FNM_DIR', 'NVM_HOME', 'NVM_SYMLINK']) {
    for (const v of values) {
      const o = { ...O, env: { [name]: v } };
      assert.equal(policy.writeDenial(home + '/notes.txt', o), null, name + '=' + v);
      assert.equal(policy.writeDenial(proj + '/src/a.js', o), null, name + '=' + v);
      assert.equal(sh('echo x > ' + home + '/notes.txt', o), null, name + '=' + v);
    }
  }
});

test('the parent folders cannot be moved or deleted to swap a protected folder', () => {
  const bad = [
    'mv ~/.local ~/.local.old',
    'mkdir -p ~/stage/bin && mv ~/stage ~/.local',
    'mv ~/.asdf ~/asdf.old',
    'rm -rf ~/.local',
    'cp -r ~/stage ~/.local',
    'mv ~/.local/share ~/share.old',
    'rm -rf ~/.asdf',
  ];
  for (const c of bad) assert.match(String(sh(c)), /protected/, c);
  const ok = ['ls ~/.local', 'cp a ~/.local/share/x.txt', 'mkdir -p ~/.local/share/app', 'touch ~/.local/foo', 'rm ~/.local/share/x.txt',
    'cp -r app ~/.local/share/app', 'cd ~/.local && ls'];
  for (const c of ok) assert.equal(sh(c), null, c);
});

test('copies by pattern, of a folder content or with no visible source into a bin folder are refused', () => {
  const bad = [
    'cp src/node* ~/.local/bin',
    'cp src/* ~/.local/bin/',
    'cp -t ~/.local/bin/ src/*',
    'cd ~/.local/bin && cp /x/* .',
    'rsync -a src/ ~/.local/bin/',
    'cp -r src/. ~/.local/bin/',
    'cp -a stage/. ~/bin',
    'xargs cp -t ~/.local/bin < list',
    'xargs -a list cp -t ~/.local/bin',
    'find src -name node -exec cp {} ~/.local/bin/ \;',
    'find src -exec cp -t ~/.local/bin {} +',
    'cp src/?ode ~/bin',
    'cp src/[nz]* ~/bin',
    'cp src/n* ~/bin',
    'cp src/{node,x} ~/bin',
    'cp --target-directory=~/bin src/*',
  ];
  for (const c of bad) assert.match(String(sh(c)), /protected/, c);
  const ok = [
    'cp ./mytool ~/.local/bin/',
    'cp src/*.sh ~/bin/',
    'cp src/*.py ~/.local/bin',
    'cp src/tool-* ~/bin/',
    'cp a b ~/.local/bin/',
    'rsync -a src/mytool ~/.local/bin/',
    'cp src/* ~/projects/out/',
  ];
  for (const c of ok) assert.equal(sh(c), null, c);
});

test('copies whose source is a variable, a substitution or a folder copied with -T into a bin folder are refused', () => {
  const bad = [
    'cp -rT src ~/.local/bin',
    'cp -r --no-target-directory src ~/.local/bin',
    'cp -aT src ~/bin',
    'cp "$f" ~/.local/bin',
    'cp $F ~/.local/bin/',
    'for f in src/*; do cp "$f" ~/.local/bin/; done',
    'while read f; do cp "$f" ~/.local/bin; done < list',
    'cp $(cat list) ~/bin',
    'cp `cat list` ~/bin',
    "find src -exec sh -c 'cp \"$1\" ~/.local/bin' _ {} \\;",
    'xargs -I F cp F ~/.local/bin < list',
    'xargs -IF cp F ~/.local/bin < list',
    'xargs --replace=F cp F ~/bin < list',
    'xargs -i cp {} ~/bin < list',
    'parallel cp {} ~/.local/bin ::: src/a',
    'parallel -j4 cp {} ~/bin ::: src/a',
    'cp src/*.ps1 ~/bin',
    'cp src/zn.ps1 ~/bin',
  ];
  for (const c of bad) assert.match(String(sh(c)), /protected/, c);
  const ok = [
    'cp -rT src ./dist',
    'cp -T a ./b',
    'cp -r src ~/.local/bin',
    'cp "$BUILD/mytool" ~/.local/bin/',
    'cp "$f" ./dist/',
    'for f in src/*; do cp "$f" ./dist/; done',
    'cp $(cat list) ./dist',
    'xargs -I F cp F ./dist < list',
    'xargs cp -t dist/ < list',
    'parallel cp {} ./dist ::: src/a',
    'find src -name "*.js" -exec cp {} dist/ \\;',
    'cp -r ./dist/ ~/bin/myapp/',
  ];
  for (const c of ok) assert.equal(sh(c), null, c);
});

test('a substitution as the source, with the destination ending in a slash or nested, and parallel and xargs commands in any form are refused', () => {
  const bad = [
    'cp $(cat list) ~/bin/',
    'cp $(cat list) $HOME/.local/bin/',
    'rsync -a $(cat list) ~/.local/bin/',
    'cp $(cat $(echo list)) ~/bin',
    'cp $(cat list) "$HOME/.local/bin/"',
    'sudo cp $(cat list) ~/bin/',
    'parallel --jobs 4 cp {} ~/bin ::: src/a',
    'parallel cp {1} ~/bin ::: src/a',
    'parallel cp {/} ~/bin ::: src/a',
    'parallel cp {.} ~/bin ::: src/a',
    'parallel -I F cp F ~/bin ::: src/a',
    "parallel 'cp {} ~/.local/bin' ::: src/a",
    'parallel --some-new-option 4 cp {} ~/bin ::: src/a',
    "xargs -I F sh -c 'cp F ~/.local/bin' < list",
    "xargs -n 1 -I F sh -c 'cp F ~/.local/bin' < list",
  ];
  for (const c of bad) assert.match(String(sh(c)), /protected/, c);
  const ok = [
    'cp $(cat list) ./dist/',
    'cp $(cat $(echo list)) ./dist',
    'cp $(git ls-files "*.sh") ./dist/',
    'echo $(cat list) ~/bin/',
    'parallel --jobs 4 cp {} ./dist ::: src/a',
    "parallel 'cp {} ./dist' ::: src/a",
    'parallel --keep-order gzip ::: a b',
    "xargs -I F sh -c 'cp F ./dist' < list",
    'cp ./mytool ~/.local/bin/',
  ];
  for (const c of ok) assert.equal(sh(c), null, c);
});
