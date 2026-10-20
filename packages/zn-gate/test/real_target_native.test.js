'use strict';

// realTargetOf resolves symlinks everywhere and, on Windows, 8.3 short names too.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { realTargetOf } = require('../lib/broker/files');

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-real-')));
}

test('posix: a symlinked directory resolves to its target, a new file keeps its name', { skip: process.platform === 'win32' && 'POSIX symlink behaviour' }, () => {
  const root = tmpDir();
  try {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'real', 'f.txt'), 'x');
    assert.equal(realTargetOf(path.join(root, 'link', 'f.txt')), path.join(root, 'real', 'f.txt'));
    assert.equal(realTargetOf(path.join(root, 'link', 'new', 'g.txt')), path.join(root, 'real', 'new', 'g.txt'));
    assert.equal(realTargetOf(path.join(root, 'real', 'f.txt')), path.join(root, 'real', 'f.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('windows: an 8.3 short path resolves to the long form', { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
  const root = tmpDir();
  try {
    const longDir = path.join(root, 'zn-a-rather-long-directory-name');
    fs.mkdirSync(longDir);
    const file = path.join(longDir, 'long-file-name-for-short-test.txt');
    fs.writeFileSync(file, 'x');
    const r = spawnSync('cmd', ['/c', 'for %I in ("' + file + '") do @echo %~sI'], { encoding: 'utf8' });
    const short = (r.stdout || '').trim();
    if (!short || short.toLowerCase() === file.toLowerCase()) {
      t.skip('8.3 short names are not generated on this volume');
      return;
    }
    assert.equal(realTargetOf(short).toLowerCase(), file.toLowerCase());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
