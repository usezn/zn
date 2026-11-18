'use strict';

// What kinds of link this machine can create, probed once in a temp folder. On POSIX everything works. On Windows
// a folder junction needs no privilege, while a file symlink needs Developer Mode or an elevated account.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
let cached;

function probe() {
  if (cached) return cached;
  const out = { dir: false, file: false, danglingDir: false };
  let base;
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-linkprobe-'));
    fs.mkdirSync(path.join(base, 'd'));
    fs.writeFileSync(path.join(base, 'f'), 'x');
    try { fs.symlinkSync(path.join(base, 'd'), path.join(base, 'ld'), DIR_LINK); out.dir = true; } catch (_) { /* no folder links */ }
    try { fs.symlinkSync(path.join(base, 'f'), path.join(base, 'lf'), 'file'); out.file = true; } catch (_) { /* no file links */ }
    try { fs.symlinkSync(path.join(base, 'gone'), path.join(base, 'lg'), DIR_LINK); out.danglingDir = true; } catch (_) { /* needs a target */ }
  } catch (_) { /* probe failed: report no links */ } finally {
    if (base) { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  }
  cached = out;
  return out;
}

// Value for the node:test `skip` option: false when the link kind works, else a precise reason.
function skipUnless(kind) {
  if (probe()[kind]) return false;
  return {
    dir: 'this machine cannot create folder links',
    file: 'file symbolic links need Developer Mode or an elevated account on Windows',
    danglingDir: 'a folder link to a missing target cannot be created here',
  }[kind];
}

// Folder link that works on every platform: a junction on Windows, a symlink elsewhere.
function linkDir(target, link) { fs.symlinkSync(target, link, DIR_LINK); }

module.exports = { probe, skipUnless, linkDir };
