'use strict';
// Exact error text of safeRestore for unsafe backups, and that the config stays unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeRestore } = require('../lib/init');

const CFG = '{"mcpServers":{"fetch":{"command":"uvx","args":["mcp-server-fetch"]}}}\n';
const SYMLINK_MSG = 'backup is a symlink or not a regular file';
const SAMEDIR_MSG = 'backup is not in the same directory as the config';
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-bakerr-')));
const canLink = (() => {
  const d = tmp();
  try { fs.symlinkSync(__filename, path.join(d, 'l')); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
const linkOpts = { skip: !canLink && 'symlinks unavailable' };

function setup(fn) {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, CFG);
    fn(d, f);
    assert.equal(fs.readFileSync(f, 'utf8'), CFG, 'the config is unchanged');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
const exact = (msg) => (e) => { assert.equal(e.message, msg); return true; };

test('safeRestore rejects a symlinked backup with the exact message', linkOpts, () => {
  setup((d, f) => {
    const target = path.join(d, 'target.json');
    fs.writeFileSync(target, '{"mcpServers":{}}');
    const b = f + '.bak.1';
    fs.symlinkSync(target, b);
    assert.throws(() => safeRestore(b, f), exact(SYMLINK_MSG));
  });
});

test('safeRestore rejects a dangling symlink backup with the exact message', linkOpts, () => {
  setup((d, f) => {
    const b = f + '.bak.1';
    fs.symlinkSync(path.join(d, 'missing.json'), b);
    assert.throws(() => safeRestore(b, f), exact(SYMLINK_MSG));
  });
});

test('safeRestore rejects a backup that is a directory with the exact message', () => {
  setup((d, f) => {
    const b = f + '.bak.1';
    fs.mkdirSync(b);
    assert.throws(() => safeRestore(b, f), exact(SYMLINK_MSG));
  });
});

test('safeRestore rejects a backup in another directory with the exact message', () => {
  setup((d, f) => {
    const other = path.join(d, 'other');
    fs.mkdirSync(other);
    const b = path.join(other, 'mcp.json.bak.1');
    fs.writeFileSync(b, '{"mcpServers":{}}');
    assert.throws(() => safeRestore(b, f), exact(SAMEDIR_MSG));
  });
});

test('safeRestore still restores a regular backup in the same directory', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, 'changed');
    const b = f + '.bak.1';
    fs.writeFileSync(b, CFG);
    safeRestore(b, f);
    assert.equal(fs.readFileSync(f, 'utf8'), CFG);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
