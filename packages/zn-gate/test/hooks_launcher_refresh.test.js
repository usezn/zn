'use strict';

// The postinstall step (lib/agents/refresh.js) rewrites the hook launchers zn-gate wrote after the runner
// changed (npm update -g), so the hooks keep working instead of blocking. It never fails an install and never
// touches anything that is not a zn launcher. Values are fake; everything runs in a temporary home.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const launcher = require('../lib/agents/launcher');
const refresh = require('../lib/agents/refresh');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');
const { hasPosixSh: posix } = require('./helpers/posix_sh');
const REAL = "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok'); process.stdout.write('REAL_RUNNER\\n'); process.exit(0);\n";

function setup(t) {
  const home = tempDir(t, 'zn-refresh-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  const runner = path.join(tempDir(t, 'zn-refresh-pkg-'), 'runner.js');
  fs.writeFileSync(runner, REAL);
  claude.install({ env, home, nodePath: process.execPath, runnerPath: runner, mcp: false });
  return { home, env, runner, file: launcher.launcherFile('claude-code', { env, home }) };
}

function hook(file) {
  return spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } });
}

test('refresh: the launcher keeps its deadline options, and Windows (Claude Code through Git Bash) is refreshed too', { skip: !posix }, (t) => {
  const ctx = setup(t);
  // A launcher written by an older package: same runner path, an old digest, a 9 s deadline.
  launcher.writeLauncher('claude-code', process.execPath, ctx.runner, { env: ctx.env, home: ctx.home, deadlineS: 9, deadlineSoft: true, runnerDigest: '00'.repeat(32) });
  let out = '';
  refresh.main({ env: ctx.env, home: ctx.home, runnerPath: ctx.runner, platform: 'win32', out: (s) => { out += s; } });
  assert.match(out, /refreshed hook launchers for claude-code/);
  const text = fs.readFileSync(ctx.file, 'utf8');
  assert.match(text, new RegExp("^ZN_SHA='" + launcher.runnerSha(ctx.runner) + "'$", 'm'));
  assert.match(text, /\/bin\/sleep 9 & ZN_SP=/);
  assert.ok(text.includes('[ -x /bin/sleep ] || { zn_cap "$@"; return 0; }'));
});

function post(ctx, extra = {}) {
  let out = '';
  refresh.main({ env: ctx.env, home: ctx.home, runnerPath: ctx.runner, out: (s) => { out += s; }, ...extra });
  return out;
}

test('refresh: an updated runner is picked up and the hook runs again instead of blocking', { skip: !posix }, (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.runner, "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok'); process.stdout.write('NEW_VERSION\\n'); process.exit(0);\n");
  assert.equal(hook(ctx.file).status, 2, 'blocked before the refresh');
  const out = post(ctx);
  assert.equal(out, 'zn-gate: refreshed hook launchers for claude-code\n');
  const r = hook(ctx.file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'NEW_VERSION');
});

test('refresh: running it twice gives byte-identical files and no output the second time', { skip: !posix }, (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.runner, REAL + '// v2\n');
  assert.notEqual(post(ctx), '');
  const first = fs.readFileSync(ctx.file);
  assert.equal(post(ctx), '');
  assert.deepEqual(fs.readFileSync(ctx.file), first);
});

test('refresh: no launcher directory means no output and no error', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-refresh-none-');
  const env = { HOME: home, ZN_HOME: path.join(home, '.zn') };
  let out = '';
  assert.doesNotThrow(() => refresh.main({ env, home, out: (s) => { out += s; } }));
  assert.equal(out, '');
});

test('refresh: a file that is not a zn launcher is left alone', { skip: !posix }, (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.runner, REAL + '// v2\n');
  const dir = path.dirname(ctx.file);
  const other = path.join(dir, 'zn-hook-other-tool.sh');
  const text = "#!/bin/sh\n# somebody else's launcher\nZN_RUNNER='" + ctx.runner + "'\nZN_NODE='" + process.execPath + "'\n";
  fs.writeFileSync(other, text);
  const wrongId = path.join(dir, 'zn-hook-codex.sh');
  const forged = '#!/bin/sh\n# Written by `zn hooks install cursor`; replaced on every install. Do not edit.\nZN_RUNNER=\'' + ctx.runner + "'\nZN_NODE='" + process.execPath + "'\n";
  fs.writeFileSync(wrongId, forged);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  post(ctx);
  assert.equal(fs.readFileSync(other, 'utf8'), text);
  assert.equal(fs.readFileSync(wrongId, 'utf8'), forged);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'hello');
});

test('refresh: a corrupted, binary or unreadable launcher does not fail the install', { skip: !posix }, (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.runner, REAL + '// v2\n');
  const dir = path.dirname(ctx.file);
  fs.writeFileSync(path.join(dir, 'zn-hook-codex.sh'), Buffer.from([0, 255, 254, 1, 2]));
  fs.mkdirSync(path.join(dir, 'zn-hook-cursor.sh'));
  fs.symlinkSync('/nonexistent/target', path.join(dir, 'zn-hook-gemini.sh'));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'agents', 'refresh.js')], {
    encoding: 'utf8', env: { ...ctx.env, HOME: ctx.home },
  });
  assert.equal(r.status, 0, r.stderr);
  // The run above used the real runner path, so it does not match the temp one; the in-process call below does.
  assert.doesNotThrow(() => post(ctx));
  assert.equal(hook(ctx.file).status, 0, 'the valid launcher was still refreshed');
});

test('refresh: the postinstall script exits 0 and prints nothing when there is nothing to do', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-refresh-cli-');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'agents', 'refresh.js')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ZN_HOME: path.join(home, '.zn') },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.postinstall, 'node lib/agents/refresh.js');
});

test('refresh: a project-local install does not repoint launchers at another copy of zn-gate', { skip: !posix }, (t) => {
  const ctx = setup(t);
  // A second copy of the runner, as in ./node_modules/zn-gate of a project.
  const localRunner = path.join(tempDir(t, 'zn-refresh-local-'), 'runner.js');
  fs.writeFileSync(localRunner, "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok'); process.stdout.write('PROJECT_COPY\\n'); process.exit(0);\n");
  const before = fs.readFileSync(ctx.file);
  // Local install: not global, and the launcher's runner still exists.
  assert.equal(post(ctx, { runnerPath: localRunner, global: false }), '');
  assert.deepEqual(fs.readFileSync(ctx.file), before);
  // Even npm_config_global=true leaves it alone while the recorded runner exists and is another file.
  assert.equal(post(ctx, { runnerPath: localRunner, global: true }), '');
  assert.deepEqual(fs.readFileSync(ctx.file), before);
  // A global install whose recorded runner is gone (an old Node.js prefix was removed) does repoint it.
  fs.unlinkSync(ctx.runner);
  assert.equal(post(ctx, { runnerPath: localRunner, global: true }), 'zn-gate: refreshed hook launchers for claude-code\n');
  assert.equal(hook(ctx.file).stdout.trim(), 'PROJECT_COPY');
  // ...but a local install with a gone runner does not.
  const ctx2 = setup(t);
  fs.unlinkSync(ctx2.runner);
  const b2 = fs.readFileSync(ctx2.file);
  assert.equal(post(ctx2, { runnerPath: localRunner, global: false }), '');
  assert.deepEqual(fs.readFileSync(ctx2.file), b2);
});

function sudoRun(ctx, extra) {
  let out = '';
  let err = '';
  refresh.main({ env: { ...ctx.env, ...(extra.env || {}) }, home: ctx.home, runnerPath: ctx.runner, out: (s) => { out += s; }, err: (s) => { err += s; }, ...(extra.uid !== undefined ? { uid: extra.uid } : {}) });
  return { out, err };
}

test('refresh: as root through sudo with nothing refreshed, one line on stderr says to run the install as yourself', { skip: !posix }, (t) => {
  const ctx = setup(t);
  const empty = tempDir(t, 'zn-refresh-root-');
  const r = sudoRun({ ...ctx, home: empty, env: { HOME: empty, ZN_HOME: path.join(empty, '.zn'), PATH: process.env.PATH } }, { uid: 0, env: { SUDO_USER: 'someone' } });
  assert.equal(r.out, '');
  assert.match(r.err, /^zn-gate: installed with sudo, so your hook launchers were not refreshed\. Run `zn hooks install <agent>` again as yourself \(without sudo\)/);
  assert.equal(r.err.trim().split('\n').length, 1);
  assert.equal(fs.existsSync(path.join(empty, '.zn')), false, 'nothing is written');
});

test('refresh: no sudo notice without root, without SUDO_USER, or when a launcher was refreshed', { skip: !posix }, (t) => {
  const ctx = setup(t);
  assert.equal(sudoRun(ctx, { uid: 1000, env: { SUDO_USER: 'someone' } }).err, '');
  assert.equal(sudoRun(ctx, { uid: 0 }).err, '');
  assert.equal(sudoRun(ctx, { uid: 0, env: { SUDO_USER: 'root' } }).err, '');
  fs.writeFileSync(ctx.runner, REAL + '// v2\n');
  const r = sudoRun(ctx, { uid: 0, env: { SUDO_USER: 'someone' } });
  assert.match(r.out, /refreshed hook launchers for claude-code/);
  assert.equal(r.err, '');
});
