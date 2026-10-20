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
// A fake home folder (a sibling of the other temp dirs) so home-scope rules are testable.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.on('exit', () => fs.rmSync(FAKE_HOME, { recursive: true, force: true }));
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

// ---------------------------------------------------------------------------
// Scope rules: project configs strict, home symlinks (dotfiles managers) allowed
// ---------------------------------------------------------------------------
const WRAPPED = '{"mcpServers":{"x":{"command":"npx","args":["-y","zn-gate","wrap","--","a"]}}}';
const projEnv = (p) => [{ name: 'P', id: 'antigravity-project', filePath: p, key: 'mcpServers', format: 'mcpServers-json', scope: 'project' }];
function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}
function mkProject() {
  const d = tmp();
  const proj = path.join(d, 'repo');
  fs.mkdirSync(path.join(proj, '.agents'), { recursive: true });
  return { d, proj, cfg: path.join(proj, '.agents', 'mcp_config.json') };
}
function clean(...paths) {
  for (const p of paths) fs.rmSync(p, { recursive: true, force: true });
}

test('project config in a symlinked .agents directory pointing into home is refused', opts, () => {
  const { d, proj } = mkProject();
  const realDir = path.join(FAKE_HOME, 'cursor-like');
  try {
    fs.rmSync(path.join(proj, '.agents'), { recursive: true });
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'mcp_config.json'), CFG);
    fs.writeFileSync(path.join(realDir, 'mcp_config.json.bak.9'), EVIL);
    fs.symlinkSync(realDir, path.join(proj, '.agents'));
    const cfg = path.join(proj, '.agents', 'mcp_config.json');
    for (const revert of [true, false]) {
      const r = inDir(proj, () => configureEnvironments({ envList: projEnv(cfg), revert }));
      assert.equal(r.actions[0].status, 'skipped_unsafe');
    }
    assert.equal(fs.readFileSync(path.join(realDir, 'mcp_config.json'), 'utf8'), CFG);
  } finally { clean(d, realDir); }
});

test('project config or backup with a second hard link is refused', () => {
  const { d, proj, cfg } = mkProject();
  try {
    fs.writeFileSync(cfg, CFG);
    const other = path.join(d, 'other-link');
    try { fs.linkSync(cfg, other); } catch { return; }
    let r = inDir(proj, () => configureEnvironments({ envList: projEnv(cfg) }));
    assert.equal(r.actions[0].status, 'skipped_unsafe');
    fs.unlinkSync(other);
    fs.writeFileSync(cfg, WRAPPED);
    const bak = cfg + '.bak.1700000000000';
    fs.writeFileSync(bak, CFG);
    fs.linkSync(bak, other);
    assert.equal(latestBackup(cfg, 'project'), null);
    assert.equal(latestBackup(cfg), bak);
    r = inDir(proj, () => configureEnvironments({ envList: projEnv(cfg), revert: true }));
    assert.notEqual(r.actions[0].status, 'reverted');
    assert.equal(fs.readFileSync(cfg, 'utf8'), WRAPPED);
  } finally { clean(d); }
});

test('home symlink to a file inside home: wrap and revert write through to the real file', opts, () => {
  const d = tmp();
  const dotfiles = path.join(FAKE_HOME, 'dotfiles');
  const link = path.join(FAKE_HOME, 'mcp-link.json');
  try {
    fs.mkdirSync(dotfiles, { recursive: true });
    const real = path.join(dotfiles, 'mcp.json');
    fs.writeFileSync(real, CFG);
    fs.symlinkSync(real, link);
    let r = inDir(d, () => configureEnvironments({ envList: env(link) }));
    assert.equal(r.actions[0].status, 'shielded');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'link is still a symlink');
    assert.equal(path.dirname(r.actions[0].backup), FAKE_HOME);
    assert.match(fs.readFileSync(real, 'utf8'), /zn-gate/);
    assert.equal(fs.readFileSync(r.actions[0].backup, 'utf8'), CFG);
    r = inDir(d, () => configureEnvironments({ envList: env(link), revert: true }));
    assert.equal(r.actions[0].status, 'reverted');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(real, 'utf8'), CFG);
    assert.equal(fs.readdirSync(dotfiles).filter((n) => n.includes('zn-tmp')).length, 0);
  } finally {
    clean(d, dotfiles, link);
    for (const n of fs.readdirSync(FAKE_HOME)) if (n.startsWith('mcp-link.json.bak.')) clean(path.join(FAKE_HOME, n));
  }
});

test('home symlink pointing into the current project is refused', opts, () => {
  const d = tmp();
  const work = path.join(FAKE_HOME, 'work');
  const link = path.join(FAKE_HOME, 'into-cwd.json');
  try {
    const proj = path.join(work, 'repo');
    fs.mkdirSync(proj, { recursive: true });
    const real = path.join(proj, 'evil.json');
    fs.writeFileSync(real, CFG);
    fs.symlinkSync(real, link);
    fs.writeFileSync(link + '.bak.5', EVIL);
    for (const revert of [true, false]) {
      const r = inDir(proj, () => configureEnvironments({ envList: env(link), revert }));
      assert.equal(r.actions[0].status, 'skipped_unsafe');
    }
    assert.equal(fs.readFileSync(real, 'utf8'), CFG);
  } finally { clean(d, work, link, link + '.bak.5'); }
});

test('wrap with an existing backup of the same name errors and does not overwrite it', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, CFG);
    const realNow = Date.now;
    Date.now = () => 1700000000555;
    try {
      fs.writeFileSync(f + '.bak.1700000000555', 'KEEP');
      const r = configureEnvironments({ envList: env(f) });
      assert.equal(r.actions[0].status, 'error');
      assert.match(r.actions[0].error, /already exists/);
    } finally { Date.now = realNow; }
    assert.equal(fs.readFileSync(f + '.bak.1700000000555', 'utf8'), 'KEEP');
    assert.equal(fs.readFileSync(f, 'utf8'), CFG);
  } finally { clean(d); }
});

test('wrap does not write through a dangling symlink at the backup name', opts, () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, CFG);
    const victim = path.join(d, 'victim');
    const realNow = Date.now;
    Date.now = () => 1700000000777;
    try {
      fs.symlinkSync(victim, f + '.bak.1700000000777');
      const r = configureEnvironments({ envList: env(f) });
      assert.equal(r.actions[0].status, 'error');
    } finally { Date.now = realNow; }
    assert.equal(fs.existsSync(victim), false);
    assert.equal(fs.readFileSync(f, 'utf8'), CFG);
  } finally { clean(d); }
});

test('revert --dry-run with a symlinked backup pointing elsewhere changes nothing', opts, () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, WRAPPED);
    const elsewhere = path.join(d, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'b'), EVIL);
    fs.symlinkSync(path.join(elsewhere, 'b'), f + '.bak.1700000000000');
    const before = fs.readdirSync(d).sort();
    const r = configureEnvironments({ envList: env(f), revert: true, dryRun: true });
    assert.notEqual(r.actions[0] && r.actions[0].status, 'reverted');
    assert.equal(fs.readFileSync(f, 'utf8'), WRAPPED);
    assert.deepEqual(fs.readdirSync(d).sort(), before);
  } finally { clean(d); }
});

test('an empty symlinked config produces no skipped_unsafe noise on wrap', opts, () => {
  const d = tmp();
  try {
    const real = path.join(d, 'empty.json');
    fs.writeFileSync(real, '{}');
    const link = path.join(d, 'l.json');
    fs.symlinkSync(real, link);
    const r = configureEnvironments({ envList: env(link) });
    assert.deepEqual(r.actions, []);
    const rv = configureEnvironments({ envList: env(link), revert: true });
    assert.equal(rv.actions[0].status, 'skipped_unsafe');
  } finally { clean(d); }
});

test('the CLI marks skipped_unsafe with the warning symbol', opts, () => {
  const { execFileSync } = require('child_process');
  const d = tmp();
  try {
    const hm = path.join(d, 'home');
    fs.mkdirSync(path.join(hm, '.cursor'), { recursive: true });
    const real = path.join(d, 'outside.json');
    fs.writeFileSync(real, CFG);
    fs.symlinkSync(real, path.join(hm, '.cursor', 'mcp.json'));
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.js'), 'init', '--revert', '--dry-run'], {
      cwd: d,
      env: { PATH: process.env.PATH, HOME: hm, USERPROFILE: hm, APPDATA: path.join(hm, 'AppData'), XDG_CONFIG_HOME: path.join(hm, '.config') },
      encoding: 'utf8',
    });
    const line = out.split('\n').find((l) => l.includes('[skipped_unsafe]'));
    assert.ok(line, out);
    assert.match(line, /!\s*Cursor/);
  } finally { clean(d); }
});

test('home scope with cwd equal to home still follows a dotfiles symlink', opts, () => {
  const dotfiles = path.join(FAKE_HOME, 'dotfiles-cwd');
  const link = path.join(FAKE_HOME, 'mcp-link-cwd.json');
  try {
    fs.mkdirSync(dotfiles, { recursive: true });
    const real = path.join(dotfiles, 'mcp.json');
    fs.writeFileSync(real, CFG);
    fs.symlinkSync(real, link);
    let r = inDir(FAKE_HOME, () => configureEnvironments({ envList: env(link) }));
    assert.equal(r.actions[0].status, 'shielded');
    assert.match(fs.readFileSync(real, 'utf8'), /zn-gate/);
    r = inDir(FAKE_HOME, () => configureEnvironments({ envList: env(link), revert: true }));
    assert.equal(r.actions[0].status, 'reverted');
    assert.equal(fs.readFileSync(real, 'utf8'), CFG);
  } finally {
    clean(dotfiles, link);
    for (const n of fs.readdirSync(FAKE_HOME)) if (n.startsWith('mcp-link-cwd.json.bak.')) clean(path.join(FAKE_HOME, n));
  }
});

test('rename retries on a busy file and then succeeds; always busy gives a clear error', () => {
  const d = tmp();
  const realRename = fs.renameSync;
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, CFG);
    let calls = 0;
    fs.renameSync = (a, b) => { if (++calls <= 2) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return realRename(a, b); };
    let r = configureEnvironments({ envList: env(f) });
    assert.equal(r.actions[0].status, 'shielded');
    assert.equal(calls, 3);
    fs.writeFileSync(f, CFG);
    calls = 0;
    fs.renameSync = () => { calls++; const e = new Error('busy'); e.code = 'EPERM'; throw e; };
    r = configureEnvironments({ envList: env(f) });
    assert.equal(r.actions[0].status, 'error');
    assert.match(r.actions[0].error, /could not replace .*in use by another program/);
    assert.equal(calls, 5);
    assert.equal(fs.readFileSync(f, 'utf8'), CFG);
    assert.equal(fs.readdirSync(d).filter((n) => n.includes('zn-tmp')).length, 0);
  } finally { fs.renameSync = realRename; clean(d); }
});

test('original file mode survives the umask', { skip: process.platform === 'win32' && 'POSIX modes only' }, () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, CFG);
    fs.chmodSync(f, 0o664);
    const old = process.umask(0o077);
    try { configureEnvironments({ envList: env(f) }); } finally { process.umask(old); }
    assert.equal(fs.statSync(f).mode & 0o777, 0o664);
  } finally { clean(d); }
});
