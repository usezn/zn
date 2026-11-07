'use strict';

// The launcher records a manifest of the package files the hook runner can load (the code and data under lib/, package.json
// and bin/cli.js, each with its SHA-256). Every module the runner requires is read once, hashed and compiled from those same
// bytes: an edited file, a file that is not in the list, a link or a file outside the package blocks the hook (exit status 86,
// then the usual "zn-gate changed" block), and a file swapped after the check never runs. Only files that are loaded are read (and the vault client files, on every call);
// `zn-gate check` (see check.test.js) reads the whole list. Everything runs on a copy of the package in a temporary folder,
// with fake values and the real `sh`.

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

const posix = process.platform !== 'win32';
const SRC = path.resolve(__dirname, '..');
const CHANGED = /zn-gate changed since the hooks were installed/;
const AGAIN = /zn hooks install claude-code/;
// A runner tells the launcher that it finished by writing the acknowledgement file the launcher names.
const ACK = "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok');\n";

function install(base, runner) {
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  getAdapter('claude-code').install({ env, home, nodePath: process.execPath, runnerPath: runner, mcp: false });
  const file = launcher.launcherFile('claude-code', { env, home });
  return { home, env, file };
}

const EVENT = (home) => JSON.stringify({ session_id: 's1', cwd: home, tool_use_id: 't1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });

/** A copy of the real package, with the real hook runner installed through the real adapter. */
function realPackage(t) {
  const base = fs.realpathSync(tempDir(t, 'zn-manifest-'));
  const pkg = path.join(base, 'pkg');
  fs.mkdirSync(pkg);
  for (const n of ['lib', 'bin', 'package.json']) fs.cpSync(path.join(SRC, n), path.join(pkg, n), { recursive: true });
  const runner = path.join(pkg, 'lib', 'hooks', 'runner.js');
  const i = install(base, runner);
  const run = () => spawnSync('/bin/sh', [i.file, 'PreToolUse'], { input: EVENT(i.home), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: i.home, ZN_HOME: i.env.ZN_HOME } });
  return { ...i, base, pkg, runner, run, p: (f) => path.join(pkg, f) };
}

/** A tiny package (lib/hooks/runner.js requires ../a.js and ../data.json) to show what is and is not checked. */
function tinyPackage(t, { manifest } = {}) {
  const base = fs.realpathSync(tempDir(t, 'zn-manifest-tiny-'));
  const pkg = path.join(base, 'pkg');
  fs.mkdirSync(path.join(pkg, 'lib', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'bin'));
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"zn-gate","version":"0.0.0"}\n');
  fs.writeFileSync(path.join(pkg, 'bin', 'cli.js'), '// cli\n');
  fs.writeFileSync(path.join(pkg, 'lib', 'a.js'), "module.exports = { v: 'A1' };\n");
  fs.writeFileSync(path.join(pkg, 'lib', 'data.json'), '{"d":"D1"}\n');
  fs.writeFileSync(path.join(pkg, 'lib', 'unused.js'), "module.exports = 'never required';\n");
  const runner = path.join(pkg, 'lib', 'hooks', 'runner.js');
  fs.writeFileSync(runner, ACK + "process.stdout.write('OK ' + require('../a.js').v + ' ' + require('../data.json').d + '\\n'); process.exit(0);\n");
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  const file = launcher.writeLauncher('claude-code', process.execPath, runner, { env, home, manifest });
  const run = () => spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  return { base, pkg, runner, file, home, env, run, p: (f) => path.join(pkg, f) };
}

test('manifest: the launcher records the list of the package files, and the intact package runs', { skip: !posix }, (t) => {
  const s = realPackage(t);
  const text = fs.readFileSync(s.file, 'utf8');
  const m = /^ZN_FILES='([^']+)'$/m.exec(text);
  assert.ok(m, 'ZN_FILES is a list');
  assert.equal(m[1], launcher.treeManifest(s.runner));
  const parsed = launcher.parseManifest(m[1]);
  assert.ok(parsed['lib/hooks/runner.js'] && parsed['lib/hooks/policy.js'] && parsed['package.json'] && parsed['bin/cli.js']);
  assert.ok(Object.keys(parsed).every((k) => /\.(js|cjs|mjs|json)$/.test(k)), 'only code and data');
  assert.equal(parsed['lib/hooks/runner.js'], launcher.runnerSha(s.runner));
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
});

for (const [label, change] of [
  ['an edited policy file', (s) => fs.appendFileSync(s.p('lib/hooks/policy.js'), '// edited\n')],
  ['an edited destructive-command file', (s) => fs.appendFileSync(s.p('lib/destructive.js'), '// edited\n')],
  ['an edited vault file', (s) => fs.appendFileSync(s.p('lib/vault/store.js'), '// edited' + String.fromCharCode(10))],
  ['an edited broker file', (s) => fs.appendFileSync(s.p('lib/broker/files.js'), '// edited\n')],
  ['an edited helper module', (s) => fs.appendFileSync(s.p('lib/zn-command.js'), '// edited\n')],
  ['a policy file replaced by a link to a copy outside the package', (s) => {
    const copy = path.join(s.base, 'outside-policy.js');
    fs.copyFileSync(s.p('lib/hooks/policy.js'), copy);
    fs.rmSync(s.p('lib/hooks/policy.js'));
    fs.symlinkSync(copy, s.p('lib/hooks/policy.js'));
  }],
]) {
  test('manifest: ' + label + ' blocks the hook before it runs', { skip: !posix }, (t) => {
    const s = realPackage(t);
    assert.equal(s.run().status, 0);
    change(s);
    const r = s.run();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, CHANGED);
    assert.match(r.stderr, AGAIN);
    assert.equal(r.stdout, '', 'nothing of it ran');
  });
}

test('manifest: a deleted module the runner needs blocks the hook', { skip: !posix }, (t) => {
  const s = realPackage(t);
  fs.rmSync(s.p('lib/hooks/policy.js'));
  const r = s.run();
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('manifest: a module that is not in the list blocks the hook when it is required', { skip: !posix }, (t) => {
  const real = fs.realpathSync(tempDir(t, 'zn-manifest-listed-'));
  const pkg = path.join(real, 'pkg');
  fs.mkdirSync(pkg);
  for (const n of ['lib', 'bin', 'package.json']) fs.cpSync(path.join(SRC, n), path.join(pkg, n), { recursive: true });
  const runner = path.join(pkg, 'lib', 'hooks', 'runner.js');
  const all = launcher.parseManifest(launcher.treeManifest(runner));
  delete all['lib/hooks/policy.js'];
  const manifest = Object.keys(all).sort().map((k) => k + '=' + all[k]).join(';');
  const home = path.join(real, 'home');
  fs.mkdirSync(home);
  const file = launcher.writeLauncher('claude-code', process.execPath, runner, { env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH }, home, manifest });
  const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: EVENT(home), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, CHANGED);
});

test('manifest: only loaded files are read: an edited file nothing requires does not stop the hook', { skip: !posix }, (t) => {
  const s = tinyPackage(t);
  assert.equal(s.run().stdout, 'OK A1 D1\n');
  fs.appendFileSync(s.p('lib/unused.js'), '// edited\n');
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'OK A1 D1\n');
  // The whole list is still different, which `zn-gate check` reports.
  assert.notEqual(launcher.treeManifest(s.runner), /^ZN_FILES='([^']+)'$/m.exec(fs.readFileSync(s.file, 'utf8'))[1]);
});

test('manifest: a module edited after install blocks the hook; without a manifest only the runner is checked and it would run', { skip: !posix }, (t) => {
  const withList = tinyPackage(t);
  fs.writeFileSync(withList.p('lib/a.js'), "module.exports = { v: 'EVIL' };\n");
  const blocked = withList.run();
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, CHANGED);
  assert.ok(!blocked.stdout.includes('EVIL'));
  const runnerOnly = tinyPackage(t, { manifest: '' });
  assert.match(fs.readFileSync(runnerOnly.file, 'utf8'), /^ZN_FILES='-'$/m);
  fs.writeFileSync(runnerOnly.p('lib/a.js'), "module.exports = { v: 'EVIL' };\n");
  assert.equal(runnerOnly.run().stdout, 'OK EVIL D1\n', 'the runner-only check does not see a module change');
});

test('manifest: data files the runner requires are covered too', { skip: !posix }, (t) => {
  const s = tinyPackage(t);
  fs.writeFileSync(s.p('lib/data.json'), '{"d":"EVIL"}\n');
  const r = s.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, CHANGED);
});

test('manifest: a module swapped on disk while the runner starts is compared with the list when it is read', { skip: !posix }, (t) => {
  // The runner rewrites lib/a.js before it requires it: the bytes read are hashed and compiled together, so there is no moment
  // between the check and the use in which the file can change unseen.
  const s = tinyPackage(t);
  fs.writeFileSync(s.runner, ACK + "require('fs').writeFileSync(require('path').join(__dirname, '..', 'a.js'), \"module.exports = { v: 'SWAPPED' };\\n\");\n" +
    "process.stdout.write('OK ' + require('../a.js').v + '\\n'); process.exit(0);\n");
  // The runner file itself changed, so install again to record it.
  launcher.writeLauncher('claude-code', process.execPath, s.runner, { env: s.env, home: s.home });
  const r = s.run();
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes('SWAPPED'));
});

test('manifest: a package whose runner is not at lib/hooks/runner.js is checked by its runner digest only', { skip: !posix }, (t) => {
  const base = fs.realpathSync(tempDir(t, 'zn-manifest-flat-'));
  const runner = path.join(base, 'runner.js');
  fs.writeFileSync(runner, ACK + "process.stdout.write('FLAT\\n'); process.exit(0);\n");
  assert.equal(launcher.treeManifest(runner), '');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const file = launcher.writeLauncher('claude-code', process.execPath, runner, { env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH }, home });
  assert.match(fs.readFileSync(file, 'utf8'), /^ZN_FILES='-'$/m);
  const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(r.stdout, 'FLAT\n');
});

test('manifest: a link or an odd name in lib/ gives no manifest (the runner digest alone is used)', { skip: !posix }, (t) => {
  const s = tinyPackage(t);
  assert.ok(launcher.treeManifest(s.runner));
  fs.symlinkSync(s.p('lib/a.js'), s.p('lib/link.js'));
  assert.equal(launcher.treeManifest(s.runner), '');
  fs.rmSync(s.p('lib/link.js'));
  fs.writeFileSync(s.p('lib/odd name.js'), '//\n');
  assert.equal(launcher.treeManifest(s.runner), '', 'a name outside the plain set cannot sit in a launcher line');
});

test('manifest: parseManifest accepts only a valid list, and a launcher is not written with a bad one', (t) => {
  const ok = 'lib/a.js=' + 'a'.repeat(64) + ';package.json=' + 'b'.repeat(64);
  assert.deepEqual(Object.keys(launcher.parseManifest(ok)), ['lib/a.js', 'package.json']);
  for (const bad of ['', null, 'lib/a.js', 'lib/a.js=short', 'lib/a.js=' + 'g'.repeat(64), '=' + 'a'.repeat(64), 'lib/a b.js=' + 'a'.repeat(64), ok + ';']) {
    assert.equal(launcher.parseManifest(bad), null, String(bad));
  }
  const home = fs.realpathSync(tempDir(t, 'zn-manifest-bad-'));
  assert.throws(() => launcher.writeLauncher('claude-code', process.execPath, __filename, { env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH }, home, manifest: 'lib/a.js=short' }), /bad manifest/);
});

test('manifest: after an update the install step rewrites the list, and the hook runs again', { skip: !posix }, (t) => {
  const s = realPackage(t);
  fs.appendFileSync(s.p('lib/hooks/policy.js'), '// the new version of the package\n');
  assert.equal(s.run().status, 2, 'blocked until the launcher is refreshed');
  let out = '';
  refresh.main({ env: s.env, home: s.home, runnerPath: s.runner, out: (x) => { out += x; }, err: () => {} });
  assert.match(out, /refreshed hook launchers for claude-code/);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(/^ZN_FILES='([^']+)'$/m.exec(fs.readFileSync(s.file, 'utf8'))[1], launcher.treeManifest(s.runner));
});

// --- zn-gate check reads the whole list ---

const { check } = require('../lib/check');

async function claudeResult(t, s) {
  const cwd = tempDir(t, 'zn-manifest-cwd-');
  return (await check({ home: s.home, env: s.env, cwd })).results.find((x) => x.id === 'claude-code');
}

test('check: the intact package is protected and has nothing to say about its files', { skip: !posix }, async (t) => {
  const s = realPackage(t);
  const r = await claudeResult(t, s);
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(!r.notes.some((n) => /files|launcher records/.test(n)), r.notes.join('\n'));
});

test('check: a changed file nothing has loaded yet is reported, with the file name and the repair', { skip: !posix }, async (t) => {
  const s = realPackage(t);
  fs.appendFileSync(s.p('lib/team/cli.js'), '// edited\n');
  assert.equal(s.run().status, 0, 'the hook itself does not load that file');
  const r = await claudeResult(t, s);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /changed since the hooks were installed \(lib\/team\/cli\.js no longer match the launcher\)/);
  assert.match(r.fix, /zn hooks install claude-code/);
});

test('check: a deleted file and a package that is no longer a plain list are reported', { skip: !posix }, async (t) => {
  const s = realPackage(t);
  fs.rmSync(s.p('lib/team/cli.js'));
  let r = await claudeResult(t, s);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /lib\/team\/cli\.js/);
  const s2 = realPackage(t);
  fs.symlinkSync(s2.p('lib/rules.js'), s2.p('lib/linked.js'));
  r = await claudeResult(t, s2);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /\(files\)/);
});

test('check: a file added since install is a note, not a block', { skip: !posix }, async (t) => {
  const s = realPackage(t);
  fs.writeFileSync(s.p('lib/extra.js'), 'module.exports = 1;\n');
  const r = await claudeResult(t, s);
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(r.notes.some((n) => /lib\/extra\.js/.test(n) && /zn hooks install claude-code/.test(n)), r.notes.join('\n'));
});

test('check: a launcher that records only the runner says so when the package could have been listed', { skip: !posix }, async (t) => {
  const s = realPackage(t);
  // Written with no list, as for a package whose files could not be listed then.
  launcher.writeLauncher('claude-code', process.execPath, s.runner, { env: s.env, home: s.home, manifest: '' });
  assert.match(fs.readFileSync(s.file, 'utf8'), /^ZN_FILES='-'$/m);
  let r = await claudeResult(t, s);
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(r.notes.some((n) => /records the zn-gate runner but not the other files/.test(n) && /zn hooks install claude-code/.test(n)), r.notes.join('\n'));
  // A launcher written by an older zn-gate has no ZN_FILES line at all.
  fs.writeFileSync(s.file, fs.readFileSync(s.file, 'utf8').replace(/^ZN_FILES=.*\n/m, ''), { mode: 0o755 });
  r = await claudeResult(t, s);
  assert.ok(r.notes.some((n) => /records the zn-gate runner but not the other files/.test(n)), r.notes.join('\n'));
});

test('check: a package that cannot be listed at all (runner elsewhere) is not nagged about it', { skip: !posix }, async (t) => {
  const base = fs.realpathSync(tempDir(t, 'zn-manifest-flat-check-'));
  const runner = path.join(base, 'runner.js');
  fs.writeFileSync(runner, ACK + "process.stdout.write('{}'); process.exit(0);\n");
  const i = install(base, runner);
  const r = (await check({ home: i.home, env: i.env, cwd: tempDir(t, 'zn-manifest-cwd-') })).results.find((x) => x.id === 'claude-code');
  assert.ok(!r.notes.some((n) => /records the zn-gate runner/.test(n)), r.notes.join('\n'));
});
