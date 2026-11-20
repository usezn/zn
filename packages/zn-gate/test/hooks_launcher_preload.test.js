'use strict';
process.env.ZN_STATS = 'off';

// A library preloaded into the shell that runs a hook (LD_PRELOAD, LD_AUDIT, DYLD_INSERT_LIBRARIES) runs before the first line of the
// launcher, so the launcher cannot remove it in time: the loader reads the variable when the shell starts. What the launcher can do is
// refuse to answer for the hook: it blocks the call and starts no hook, and the programs it starts itself (mktemp, rm, node) get a clean
// environment. This test checks that, and with a real shared library (a constructor that only appends a line to a marker file) that the
// preload code runs in the shell only, never in a second program, and that no hook code runs. Nothing destructive is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');
const loaderEnv = require('../lib/loader-env');
const { tempDir } = require('./helpers/tmp');
const { hasPosixSh: posix } = require('./helpers/posix_sh');

// A stub runner: records that it ran, confirms its answer like the real runner and prints an empty JSON answer.
const RUNNER = "const fs = require('fs');" +
  "fs.appendFileSync(process.env.ZN_TEST_RAN, 'hook ran\\n');" +
  "if (process.env.ZN_HOOK_ACK) fs.writeFileSync(process.env.ZN_HOOK_ACK, 'ok');" +
  "process.stdout.write('{}\\n');\n";

function fixture(t) {
  const dir = tempDir(t, 'zn-hook-preload-');
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, RUNNER);
  const launcherFile = path.join(dir, 'zn-hook-claude-code.sh');
  fs.writeFileSync(launcherFile, launcher.unixScript('claude-code', process.execPath, runner, { manifest: '' }), { mode: 0o755 });
  return { dir, launcherFile, ran: path.join(dir, 'ran.txt'), mark: path.join(dir, 'preload-mark.txt') };
}

function run(f, extra) {
  const env = { PATH: process.env.PATH, HOME: f.dir, TMPDIR: f.dir, ZN_TEST_RAN: f.ran, ZN_TEST_PRELOAD_MARK: f.mark, ...extra };
  return spawnSync('/bin/sh', [f.launcherFile, 'PreToolUse'], { input: '{}', encoding: 'utf8', env });
}

// On macOS dyld ends /bin/sh itself when a DYLD_ variable names a library that is not there, before any hook code exists: the hook must
// not run either way, and the status 2 block is only required where the shell survives (everywhere else).
// The same for the ld.so trace and debug variables: the loader prints and the shell exits with no script run at all (see the threat model).
const dyldKills = (name) => (process.platform === 'darwin' && name.startsWith('DYLD_')) || /^LD_(TRACE_LOADED_OBJECTS|DEBUG)/.test(name);

for (const name of loaderEnv.LOADER_PRELOAD) {
  test('sh launcher: ' + name + ' set in the environment blocks the call and the hook does not run', { skip: !posix }, (t) => {
    const f = fixture(t);
    const r = run(f, { [name]: path.join(f.dir, 'missing-zn-test.so') });
    assert.equal(fs.existsSync(f.ran), false, 'the hook ran in a shell with a preload');
    // Where the loader stops the shell before the script (a status other than 2, nothing printed) there is no answer to check; wherever
    // the script does run it must block, never return success.
    if (dyldKills(name) && r.status !== 2) { assert.notEqual(r.stdout.trim(), '{}', name + ': the hook answered'); return; }
    assert.equal(r.status, 2, name + ': ' + r.stderr);
    assert.match(r.stderr, /unset it and restart the agent/);
  });
}

test('sh launcher: an empty preload variable is not a refusal, and another LD_ variable is cleaned as before', { skip: !posix }, (t) => {
  const f = fixture(t);
  for (const extra of [{}, { LD_PRELOAD: '' }, { LD_ZN_TEST_ANY: f.dir }]) {
    fs.rmSync(f.ran, { force: true });
    const r = run(f, extra);
    assert.equal(r.status, 0, JSON.stringify(extra) + ' ' + r.stderr);
    assert.equal(r.stdout.trim(), '{}');
    assert.equal(fs.readFileSync(f.ran, 'utf8'), 'hook ran\n');
  }
});

test('sh launcher: the refusal comes before any other program is started, and is the block of the agent', { skip: !posix }, (t) => {
  const text = launcher.unixScript('claude-code', process.execPath, '/opt/zn/lib/hooks/runner.js', { runnerDigest: 'a'.repeat(64), manifest: '', deadlineS: 5 });
  const at = text.indexOf('ZN_LOADER=;');
  assert.ok(at > 0, 'the launcher reads the preload variables');
  assert.ok(at < text.indexOf('unset GCONV_PATH'), 'they are read before the scrub removes them');
  assert.ok(at < text.indexOf('zn_mk ack'), 'and before the first mktemp');
  assert.match(text, /if \[ -z "\$ZN_LOADER" \] && \[ -x "\$ZN_NODE" \]/);
});

// The real thing: a library whose constructor appends a line to a marker file. Linux only (a C compiler and ld.so's LD_PRELOAD).
function compiler() {
  for (const cc of ['cc', 'gcc', 'clang']) {
    const r = spawnSync(cc, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return cc;
  }
  return null;
}
const cc = process.platform === 'linux' ? compiler() : null;
const skipReason = process.platform !== 'linux' ? 'LD_PRELOAD of a real library is tested on Linux only' : !cc ? 'no C compiler (cc, gcc or clang) on this machine' : false;

test('the refused list holds the FreeBSD and ld.so names that change what the shell runs', () => {
  for (const n of ['LD_PRELOAD_FDS', 'LD_TRACE_LOADED_OBJECTS', 'LD_DEBUG', 'LD_DEBUG_OUTPUT', 'LD_LIBRARY_PATH_FDS']) {
    assert.ok(loaderEnv.LOADER_PRELOAD.includes(n), n + ' is refused');
    assert.ok(loaderEnv.SH_UNSET_NAMES.includes(n), n + ' is unset');
  }
});

test('sh launcher: a real preload runs in the shell only, never in a program the launcher starts, and no hook code runs', { skip: skipReason }, (t) => {
  const f = fixture(t);
  const src = path.join(f.dir, 'pre.c');
  fs.writeFileSync(src, '#include <stdio.h>\n#include <stdlib.h>\n' +
    '__attribute__((constructor)) static void zn_test_mark(void) { const char *p = getenv("ZN_TEST_PRELOAD_MARK"); if (p) { FILE *h = fopen(p, "a"); if (h) { fputs("preload\\n", h); fclose(h); } } }\n');
  const so = path.join(f.dir, 'libznpre.so');
  const b = spawnSync(cc, ['-shared', '-fPIC', '-o', so, src], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  // Sanity: the library does load into a program started with the variable.
  const s = spawnSync('/bin/sh', ['-c', 'exit 0'], { env: { PATH: process.env.PATH, LD_PRELOAD: so, ZN_TEST_PRELOAD_MARK: f.mark } });
  assert.equal(s.status, 0);
  assert.equal(fs.readFileSync(f.mark, 'utf8'), 'preload\n', 'sanity: the constructor ran in the shell');
  fs.rmSync(f.mark);
  const r = run(f, { LD_PRELOAD: so });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(f.ran), false, 'the hook ran');
  // One line: the shell itself (it cannot be protected). mktemp, rm and the rest got a clean environment.
  assert.equal(fs.readFileSync(f.mark, 'utf8'), 'preload\n');
});

test('sh launcher: LD_LIBRARY_PATH naming a real library folder blocks the call and the hook does not run', { skip: skipReason }, (t) => {
  const f = fixture(t);
  const libs = path.join(f.dir, 'libs');
  fs.mkdirSync(libs);
  const src = path.join(f.dir, 'alt.c');
  fs.writeFileSync(src, 'int zn_test_alt(void) { return 1; }\n');
  const b = spawnSync(cc, ['-shared', '-fPIC', '-o', path.join(libs, 'libznalt.so'), src], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  const r = run(f, { LD_LIBRARY_PATH: libs });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(f.ran), false, 'the hook ran in a shell with an alternate library folder');
});

// ---- the project guard (sh -c form for most agents, the split-on-spaces form of Antigravity)
function mkbin(t) {
  const dir = tempDir(t, 'zn-guard-preload-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const sh = fs.realpathSync('/bin/sh');
  fs.symlinkSync(sh, path.join(bin, 'sh'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const ran = path.join(dir, 'ran');
  fs.writeFileSync(path.join(bin, 'zn'), '#!' + sh + '\n: > ' + JSON.stringify(ran) + '\nexit 0\n', { mode: 0o755 });
  return { bin, ran };
}
const guardForms = {
  'sh -c': (bin, env) => {
    const cmd = launcher.projectShCommand('claude-code', 'PreToolUse');
    const script = cmd.slice(6).replace(/^'|'$/g, '').replace(/'"'"'/g, "'");
    return spawnSync(path.join(bin, 'sh'), ['-c', script], { input: '{}', encoding: 'utf8', env, cwd: '/' });
  },
  'Antigravity split form': (bin, env) => {
    const parts = launcher.projectShCommand('antigravity').split(' ');
    return spawnSync(path.join(bin, parts[0]), parts.slice(1), { input: '{}', encoding: 'utf8', env, cwd: '/' });
  },
};
for (const [name, runGuard] of Object.entries(guardForms)) {
  test('project guard (' + name + '): a preload variable blocks the call and zn is not started; without it zn runs', { skip: !posix }, (t) => {
    const b = mkbin(t);
    const clean = { PATH: b.bin + ':/usr/bin:/bin' };
    const ok = runGuard(b.bin, clean);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.existsSync(b.ran), true, 'sanity: zn runs with a clean environment');
    fs.rmSync(b.ran);
    for (const v of loaderEnv.LOADER_PRELOAD) {
      const r = runGuard(b.bin, { ...clean, [v]: '/nonexistent/zn-test.so' });
      assert.equal(fs.existsSync(b.ran), false, v + ': zn started in a shell with a preload');
      if (dyldKills(v) && r.status !== 2 && r.status !== 0) continue;
      if (dyldKills(v) && r.status === 0 && !r.stdout.trim()) continue;
      if (name.startsWith('Antigravity')) {
        assert.equal(r.status, 0, r.stderr);
        assert.match(JSON.parse(r.stdout.trim()).reason, /library variable \(LD_PRELOAD, LD_LIBRARY_PATH/);
      } else {
        assert.equal(r.status, 2, r.stderr);
        assert.match(r.stderr, /unset it and restart the agent/);
      }
    }
  });
}

test('project guard: the guard that refuses a preload is still recognised, and old guards still are', () => {
  for (const agent of ['claude-code', 'cursor', 'copilot', 'antigravity']) {
    for (const e of [undefined, 'PreToolUse']) {
      const cmd = launcher.projectShCommand(agent, e);
      assert.equal(launcher.isProjectGuard(cmd, agent), true, agent);
      assert.equal(launcher.isProjectGuardExact(cmd, agent), true, agent);
    }
  }
});
