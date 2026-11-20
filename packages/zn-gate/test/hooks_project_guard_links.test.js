'use strict';
process.env.ZN_STATS = 'off';

// The project hook guard runs the `zn` it finds on the PATH. A PATH entry outside node_modules can be a link into
// node_modules/.bin, or hold a zn that is a link into the project: the guard must check where the program really is, not
// only the path text. The planted zn only writes a marker file; nothing destructive is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const launcher = require('../lib/agents/launcher');
const opencode = require('../lib/agents/opencode');
const { tempDir } = require('./helpers/tmp');

const skip = { skip: process.platform === 'win32' ? 'POSIX links and sh; the Windows guard checks only the path text (see the threat model)' : false };

function whichSh() {
  for (const d of String(process.env.PATH || '').split(':')) {
    const f = path.join(d, 'sh');
    if (d && fs.existsSync(f)) return fs.realpathSync(f);
  }
  return '/bin/sh';
}
const SYS = '/usr/bin:/bin';

/* A project folder (the hook's working folder) and, outside it, folders for the PATH. */
function layout(t) {
  const root = fs.realpathSync(tempDir(t, 'zn-guard-links-'));
  const proj = path.join(root, 'proj');
  const nmBin = path.join(proj, 'node_modules', '.bin');
  fs.mkdirSync(nmBin, { recursive: true });
  fs.mkdirSync(path.join(proj, 'bin'), { recursive: true });
  const marker = path.join(root, 'marker');
  const zn = (dir) => {
    const f = path.join(dir, 'zn');
    fs.writeFileSync(f, '#!' + whichSh() + '\necho ran > ' + marker + '\nexit 0\n');
    fs.chmodSync(f, 0o755);
    return f;
  };
  const nodeIn = (dir) => fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  return { root, proj, nmBin, marker, zn, nodeIn };
}

const forms = {
  'sh -c': (bin, cwd) => {
    const cmd = launcher.projectShCommand('claude-code', 'PreToolUse');
    const script = cmd.slice(6).replace(/^'|'$/g, '').replace(/'\\''/g, "'");
    return spawnSync(whichSh(), ['-c', script], { input: '{}', encoding: 'utf8', env: { PATH: bin + ':' + SYS, HOME: '/nonexistent-home' }, cwd });
  },
  'split-on-spaces (Antigravity)': (bin, cwd) => {
    const parts = launcher.projectShCommand('antigravity').split(' ');
    return spawnSync(whichSh(), parts.slice(1), { input: '{}', encoding: 'utf8', env: { PATH: bin + ':' + SYS, HOME: '/nonexistent-home' }, cwd });
  },
};

for (const [name, run] of Object.entries(forms)) {
  test('project guard, ' + name + ': a PATH folder that is a link into node_modules/.bin is not trusted', skip, (t) => {
    const l = layout(t);
    l.zn(l.nmBin);
    l.nodeIn(l.nmBin);
    const outside = path.join(l.root, 'outside-bin');
    fs.symlinkSync(l.nmBin, outside);
    const r = run(outside, l.proj);
    assert.equal(fs.existsSync(l.marker), false, 'the planted zn ran: ' + r.stderr);
  });

  test('project guard, ' + name + ': a zn that is a link into node_modules/.bin is not trusted', skip, (t) => {
    const l = layout(t);
    const planted = l.zn(l.nmBin);
    const tools = path.join(l.root, 'tools');
    fs.mkdirSync(tools);
    fs.symlinkSync(planted, path.join(tools, 'zn'));
    l.nodeIn(tools);
    const r = run(tools, l.proj);
    assert.equal(fs.existsSync(l.marker), false, 'the planted zn ran: ' + r.stderr);
  });

  test('project guard, ' + name + ': a zn that is a link into the project folder is not trusted', skip, (t) => {
    const l = layout(t);
    const planted = l.zn(path.join(l.proj, 'bin'));
    const tools = path.join(l.root, 'tools');
    fs.mkdirSync(tools);
    fs.symlinkSync(planted, path.join(tools, 'zn'));
    l.nodeIn(tools);
    const r = run(tools, l.proj);
    assert.equal(fs.existsSync(l.marker), false, 'the planted zn ran: ' + r.stderr);
  });

  test('project guard, ' + name + ': a global npm install (bin/zn linked into lib/node_modules/zn-gate) still runs (control)', skip, (t) => {
    const l = layout(t);
    const pkgBin = path.join(l.root, 'prefix', 'lib', 'node_modules', 'zn-gate', 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    const cli = l.zn(pkgBin);
    const bin = path.join(l.root, 'prefix', 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(path.relative(bin, cli), path.join(bin, 'zn'));
    l.nodeIn(bin);
    const r = run(bin, l.proj);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(l.marker), true, 'the guard no longer runs a global zn: ' + r.stderr);
  });
}

test('the Antigravity form still holds no space, and the sh -c form is still recognised', () => {
  assert.ok(!/\s/.test(launcher.projectShCommand('antigravity').slice(6)));
  assert.equal(launcher.isProjectGuard(launcher.projectShCommand('antigravity'), 'antigravity'), true);
  const cmd = launcher.projectShCommand('codex', 'PreToolUse');
  assert.equal(launcher.isProjectGuard(cmd, 'codex'), true);
  assert.ok(cmd.indexOf('readlink -f') < cmd.indexOf('"$Z" hook codex'), 'the real path is read before zn runs');
});

test('OpenCode project plugin: a PATH folder linked into node_modules/.bin, or holding a zn linked into the project, is dropped', skip, (t) => {
  const l = layout(t);
  l.zn(l.nmBin);
  const outside = path.join(l.root, 'outside-bin');
  fs.symlinkSync(l.nmBin, outside);
  const planted = l.zn(path.join(l.proj, 'bin'));
  const tools = path.join(l.root, 'tools');
  fs.mkdirSync(tools);
  fs.symlinkSync(planted, path.join(tools, 'zn'));
  const pkgBin = path.join(l.root, 'prefix', 'lib', 'node_modules', 'zn-gate', 'bin');
  fs.mkdirSync(pkgBin, { recursive: true });
  const cli = l.zn(pkgBin);
  const good = path.join(l.root, 'prefix', 'bin');
  fs.mkdirSync(good);
  fs.symlinkSync(cli, path.join(good, 'zn'));
  const src = opencode.pluginSource({ scope: 'project' });
  assert.match(src, /import \{ existsSync, realpathSync \} from "node:fs";/);
  const m = src.match(/function projectEnv\(\) \{[\s\S]*?\n\}\n/)[0];
  const env = new Function('process', 'realpathSync', 'existsSync', 'homedir', m + '; return projectEnv();')(
    { platform: 'linux', cwd: () => l.proj, env: { PATH: [outside, tools, good, '/usr/bin'].join(':') } },
    fs.realpathSync, fs.existsSync, () => '/nonexistent-home');
  assert.equal(env.PATH, [good, '/usr/bin'].join(':'));
});
