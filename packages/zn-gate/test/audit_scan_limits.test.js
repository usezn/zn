'use strict';
// `zn audit` says when it stops at the directory depth limit, and `zn-gate scan`
// lists the symbolic links it does not follow, as the Python scan does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { audit } = require('../lib/audit');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ENV = { ...process.env, ZN_LOCAL_ONLY: 'true' };
const LIMIT = 64;

function deepTree(levels, withConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-depth-'));
  const parts = Array(levels).fill('d');
  const bottom = path.join(dir, ...parts);
  fs.mkdirSync(bottom, { recursive: true });
  if (withConfig) {
    fs.mkdirSync(path.join(bottom, '.claude'));
    fs.writeFileSync(path.join(bottom, '.claude', 'settings.json'), '{"hooks":{}}\n');
  }
  return dir;
}

test('audit reports a directory deeper than the limit instead of dropping it', () => {
  const dir = deepTree(LIMIT + 5, true);
  try {
    const r = audit({ root: dir });
    assert.strictEqual(r.truncated, true);
    const f = r.findings.find((x) => x.id === 'ZNA020' && /directory levels deep/.test(x.detail || x.message || ''));
    assert.ok(f, 'ZNA020 for the depth limit: ' + JSON.stringify(r.findings));
    assert.strictEqual(f.severity, 'high');
    assert.ok(f.file.startsWith('d/d/'), f.file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit within the depth limit is unchanged', () => {
  const dir = deepTree(LIMIT - 5, true);
  try {
    const r = audit({ root: dir });
    assert.ok(!r.truncated);
    assert.ok(!r.findings.some((x) => x.id === 'ZNA020'), JSON.stringify(r.findings));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan lists a symbolic link it does not follow, like the Python scan', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-symscan-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'real.md'), 'hello\n');
    fs.symlinkSync('real.md', path.join(dir, 'sub', 'link.md'));
    fs.symlinkSync('..', path.join(dir, 'sub', 'up'));
    const r = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'json'], { encoding: 'utf8', env: ENV });
    const data = JSON.parse(r.stdout);
    assert.deepStrictEqual(data.skipped.map((s) => [path.basename(s.file), s.reason]), [['link.md', 'not a regular file']]);
    assert.strictEqual(data.total_files, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
