'use strict';

process.env.ZN_STATS = 'off';

// zn's folder (~/.zn) unusable: a file in its place, or no access. secret and unlock used to answer "the vault is not
// answering, run lock then unlock" and a raw ENOTDIR/EACCES, a loop with no way out. They now name the folder and the fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const zn = (home, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_STATS: 'off' }, input: '', encoding: 'utf8', timeout: 30000,
});

test('a file where ~/.zn should be: secret and unlock name the folder and the fix, not lock/unlock or ENOTDIR', { skip: process.platform === 'win32' }, (t) => {
  const home = tempDir(t, 'zn-folder-file-');
  fs.writeFileSync(path.join(home, '.zn'), 'x');
  for (const args of [['secret', 'list'], ['unlock']]) {
    const r = zn(home, ...args);
    const out = r.stdout + r.stderr;
    assert.notEqual(r.status, 0, args.join(' '));
    assert.ok(out.includes("zn's folder " + path.join(home, '.zn') + ' cannot be used: a file is where the folder should be.'), args.join(' ') + ': ' + out);
    assert.doesNotMatch(out, /not answering|ENOTDIR/, args.join(' '));
  }
});

test('~/.zn with no access: secret and unlock name the folder and the fix', { skip: process.platform === 'win32' || isRoot }, (t) => {
  const home = tempDir(t, 'zn-folder-000-');
  const dir = path.join(home, '.zn');
  fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
  fs.chmodSync(dir, 0o000);
  try {
    for (const args of [['secret', 'list'], ['unlock']]) {
      const r = zn(home, ...args);
      const out = r.stdout + r.stderr;
      assert.ok(out.includes("zn's folder " + dir + ' cannot be used: your account is not allowed to open it.'), args.join(' ') + ': ' + out);
      assert.doesNotMatch(out, /not answering|EACCES/, args.join(' '));
    }
  } finally { fs.chmodSync(dir, 0o700); }
});
