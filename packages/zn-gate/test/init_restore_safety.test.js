'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { configureEnvironments, latestBackup, safeRestore } = require('../lib/init');

const CFG = JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }, null, 2);
const EVIL = '{"mcpServers":{"evil":{"command":"evil"}}}';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-safe-'));
const env = (p) => [{ name: 'T', id: 'claude-desktop', filePath: p, key: 'mcpServers' }];
const canLink = (() => {
  const d = tmp();
  try { fs.symlinkSync(__filename, path.join(d, 'l')); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
const opts = { skip: !canLink && 'symlinks unavailable' };

test('revert picks the numerically newest timestamp backup, not .bak.9 or .bak.old', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, '{"mcpServers":{"x":{"command":"npx","args":["-y","zn-gate","wrap","--","a"]}}}');
    fs.writeFileSync(f + '.bak.9', 'bad9');
    fs.writeFileSync(f + '.bak.old', 'badold');
    fs.writeFileSync(f + '.bak.1700000000001', CFG);
    fs.writeFileSync(f + '.bak.1700000000000', 'older');
    assert.equal(latestBackup(f), f + '.bak.1700000000001');
    const r = configureEnvironments({ envList: env(f), revert: true });
    assert.equal(r.actions[0].status, 'reverted');
    assert.equal(fs.readFileSync(f, 'utf8'), CFG);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('revert refuses a symlinked config and leaves the target alone', opts, () => {
  const d = tmp();
  try {
    const home = path.join(d, 'home.json');
    fs.writeFileSync(home, CFG);
    const f = path.join(d, 'proj.json');
    fs.symlinkSync(home, f);
    fs.writeFileSync(f + '.bak.5', EVIL);
    const r = configureEnvironments({ envList: env(f), revert: true });
    assert.equal(r.actions[0].status, 'skipped_unsafe');
    assert.match(r.actions[0].error, /proj\.json/);
    assert.equal(fs.readFileSync(home, 'utf8'), CFG);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('revert refuses a symlinked backup', opts, () => {
  const d = tmp();
  try {
    const secret = path.join(d, 'secret');
    fs.writeFileSync(secret, 'PRIVATE');
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, CFG);
    fs.symlinkSync(secret, f + '.bak.1700000000000');
    assert.equal(latestBackup(f), null);
    const r = configureEnvironments({ envList: env(f), revert: true });
    assert.notEqual(r.actions[0].status, 'reverted');
    assert.equal(fs.readFileSync(f, 'utf8'), CFG);
    assert.throws(() => safeRestore(f + '.bak.1700000000000', f), /backup is a symlink/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('safeRestore refuses a backup that lives in another real directory', () => {
  const d = tmp();
  try {
    const other = path.join(d, 'other');
    fs.mkdirSync(other);
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, CFG);
    const b = path.join(other, 'mcp.json.bak.1');
    fs.writeFileSync(b, 'x');
    assert.throws(() => safeRestore(b, f), /same directory/);
    assert.equal(fs.readFileSync(f, 'utf8'), CFG);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('project config symlinked to a home config is not overwritten by revert', opts, () => {
  const d = tmp();
  try {
    const homeDir = path.join(d, 'home', '.cursor');
    const proj = path.join(d, 'repo', '.agents');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    const home = path.join(homeDir, 'mcp.json');
    fs.writeFileSync(home, CFG);
    const pc = path.join(proj, 'mcp_config.json');
    fs.symlinkSync(home, pc);
    fs.writeFileSync(pc + '.bak.9', EVIL);
    const r = configureEnvironments({ envList: [{ name: 'Antigravity (this project)', id: 'antigravity-project', filePath: pc, key: 'mcpServers', format: 'mcpServers-json' }], revert: true });
    assert.equal(r.actions[0].status, 'skipped_unsafe');
    assert.equal(fs.readFileSync(home, 'utf8'), CFG);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('wrap refuses a symlinked config (also on dry run)', opts, () => {
  const d = tmp();
  try {
    const home = path.join(d, 'home.json');
    fs.writeFileSync(home, CFG);
    const f = path.join(d, 'link.json');
    fs.symlinkSync(home, f);
    for (const dryRun of [false, true]) {
      const r = configureEnvironments({ envList: env(f), dryRun });
      assert.equal(r.actions[0].status, 'skipped_unsafe');
    }
    assert.equal(fs.readFileSync(home, 'utf8'), CFG);
    assert.deepEqual(fs.readdirSync(d).sort(), ['home.json', 'link.json']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('wrap still writes a regular backup and wraps a regular config', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, CFG);
    const r = configureEnvironments({ envList: env(f) });
    assert.equal(r.actions[0].status, 'shielded');
    assert.equal(fs.readFileSync(r.actions[0].backup, 'utf8'), CFG);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
