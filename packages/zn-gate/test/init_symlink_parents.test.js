'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { configureEnvironments } = require('../lib/init');

// The programs a shielded server is written with, without depending on what is installed here: the wrapper and every
// server program by an absolute path.
const FAKE_PROGRAMS = {
  launcher: ['/fake/node', '/fake/zn-gate/bin/cli.js', 'shield'],
  resolveProgram: (name) => (name.includes('/') ? name : '/fake/bin/' + name),
};

const CFG = JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }, null, 2);
const canLink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-lnk-'));
  try { fs.symlinkSync(__filename, path.join(d, 'l')); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
const opts = { skip: !canLink && 'symlinks unavailable' };
const env = (p) => [{ name: 'Cursor', id: 'cursor', filePath: p, key: 'mcpServers', format: 'mcpServers-json' }];

// Runs fn(base, realHome) with HOME pointing at realHome (or a link to it) and everything cleaned up after.
function withHome(viaLink, fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-par-')));
  const realHome = path.join(base, 'realhome');
  fs.mkdirSync(realHome);
  let home = realHome;
  if (viaLink) {
    home = path.join(base, 'homelink');
    fs.symlinkSync(realHome, home);
  }
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  delete process.env.CODEX_HOME;
  try {
    fn(base, home);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.XDG !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG;
    if (saved.APPDATA !== undefined) process.env.APPDATA = saved.APPDATA;
    if (saved.CODEX_HOME !== undefined) process.env.CODEX_HOME = saved.CODEX_HOME;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('a normal install shields the config and writes the backup next to it', () => {
  withHome(false, (base, home) => {
    const f = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(f));
    fs.writeFileSync(f, CFG);
    const r = configureEnvironments({ ...FAKE_PROGRAMS, envList: env(f) });
    assert.equal(r.actions[0].status, 'shielded');
    assert.notEqual(fs.readFileSync(f, 'utf8'), CFG);
    assert.equal(fs.readFileSync(r.actions[0].backup, 'utf8'), CFG);
    assert.equal(path.dirname(r.actions[0].backup), path.dirname(f));
  });
});

test('a symlinked ~/.cursor that leads outside home is refused, nothing outside is touched', opts, () => {
  withHome(false, (base, home) => {
    const ext = path.join(base, 'external');
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(ext, 'mcp.json'), CFG);
    fs.symlinkSync(ext, path.join(home, '.cursor'));
    const f = path.join(home, '.cursor', 'mcp.json');
    const r = configureEnvironments({ ...FAKE_PROGRAMS, envList: env(f) });
    assert.equal(r.actions[0].status, 'skipped_unsafe');
    assert.match(r.actions[0].error, /\.cursor is a link that leads outside/);
    assert.match(r.actions[0].error, /will not write through/);
    assert.equal(fs.readFileSync(path.join(ext, 'mcp.json'), 'utf8'), CFG);
    assert.deepEqual(fs.readdirSync(ext), ['mcp.json']);
    // revert is refused too, even with a backup planted outside
    fs.writeFileSync(path.join(ext, 'mcp.json.bak.5'), '{"mcpServers":{"evil":{"command":"evil"}}}');
    const rv = configureEnvironments({ ...FAKE_PROGRAMS, envList: env(f), revert: true });
    assert.equal(rv.actions[0].status, 'skipped_unsafe');
    assert.equal(fs.readFileSync(path.join(ext, 'mcp.json'), 'utf8'), CFG);
  });
});

test('a symlinked parent that stays inside home still works', opts, () => {
  withHome(false, (base, home) => {
    const dot = path.join(home, 'dotfiles', 'cursor');
    fs.mkdirSync(dot, { recursive: true });
    fs.writeFileSync(path.join(dot, 'mcp.json'), CFG);
    fs.symlinkSync(dot, path.join(home, '.cursor'));
    const f = path.join(home, '.cursor', 'mcp.json');
    const r = configureEnvironments({ ...FAKE_PROGRAMS, envList: env(f) });
    assert.equal(r.actions[0].status, 'shielded');
    assert.notEqual(fs.readFileSync(path.join(dot, 'mcp.json'), 'utf8'), CFG);
    assert.equal(fs.readFileSync(r.actions[0].backup, 'utf8'), CFG);
    assert.equal(path.dirname(r.actions[0].backup), dot);
    const rv = configureEnvironments({ ...FAKE_PROGRAMS, envList: env(f), revert: true });
    assert.equal(rv.actions[0].status, 'reverted');
    assert.equal(fs.readFileSync(path.join(dot, 'mcp.json'), 'utf8'), CFG);
  });
});

test('a home folder that is itself a symlink works', opts, () => {
  withHome(true, (base, home) => {
    const f = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(f));
    fs.writeFileSync(f, CFG);
    const r = configureEnvironments({ ...FAKE_PROGRAMS, envList: env(f) });
    assert.equal(r.actions[0].status, 'shielded');
    assert.notEqual(fs.readFileSync(f, 'utf8'), CFG);
    // a link inside that home to another place inside the same home works as well
    const dot = path.join(home, 'dot');
    fs.mkdirSync(dot);
    fs.writeFileSync(path.join(dot, 'mcp.json'), CFG);
    fs.rmSync(path.join(home, '.cursor'), { recursive: true });
    fs.symlinkSync(dot, path.join(home, '.cursor'));
    const r2 = configureEnvironments({ ...FAKE_PROGRAMS, envList: env(f) });
    assert.equal(r2.actions[0].status, 'shielded');
  });
});

test('a final-entry symlink that points outside home is refused, as before', opts, () => {
  withHome(false, (base, home) => {
    const ext = path.join(base, 'outside.json');
    fs.writeFileSync(ext, CFG);
    const f = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(f));
    fs.symlinkSync(ext, f);
    const r = configureEnvironments({ ...FAKE_PROGRAMS, envList: env(f) });
    assert.equal(r.actions[0].status, 'skipped_unsafe');
    assert.equal(fs.readFileSync(ext, 'utf8'), CFG);
    assert.deepEqual(fs.readdirSync(base).sort(), ['outside.json', 'realhome']);
  });
});

test('default scan: a symlinked ~/.cursor to an outside folder is not shielded and the outside file stays a plain, unchanged file', opts, () => {
  // Same shape as the verified report: HOME is the working folder, ~/.cursor leads outside it.
  withHome(false, (base, home) => {
    const ext = path.join(base, 'outside');
    fs.mkdirSync(ext);
    const file = path.join(ext, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['server.js'] } } }, null, 2));
    fs.symlinkSync(ext, path.join(home, '.cursor'));
    const before = fs.readFileSync(file, 'utf8');
    const cwd = process.cwd();
    process.chdir(home);
    try {
      const r = configureEnvironments({});
      const cursor = r.actions.filter((a) => /cursor/i.test(a.env));
      assert.ok(cursor.length > 0);
      for (const a of cursor) assert.notEqual(a.status, 'shielded');
      assert.equal(cursor[0].status, 'skipped_unsafe');
    } finally {
      process.chdir(cwd);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(fs.lstatSync(file).isFile());
    assert.deepEqual(fs.readdirSync(ext), ['mcp.json']);
  });
});
