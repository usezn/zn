'use strict';

// The lean launcher (Windows): shell built-ins and one node. It must keep every guarantee of the full launcher: block on a crash,
// on a runner that did not confirm its answer, on a deadline, on a changed runner and on a missing Node.js, hold a half answer
// back, and map the exit status the same way. The script runs under the real `sh` here too, so Linux can prove it. Values are fake.
// The POSIX launchers must stay byte for byte what they were: test/fixtures/launcher_posix_sha256.json holds the SHA-256 of
// the scripts of the full launcher, taken before the lean one existed.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');
const { getAdapter } = require('../lib/agents');
const refresh = require('../lib/agents/refresh');
const { tempDir } = require('./helpers/tmp');

const posix = process.platform !== 'win32';
const REAL_RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const AGENTS = ['claude-code', 'cursor', 'gemini', 'antigravity', 'zcode', 'codex', 'copilot'];

// Writes a launcher for a fake runner in a temporary folder; returns what a test needs.
function setup(t, runnerSource, o = {}) {
  const dir = tempDir(t, 'zn-b2342-');
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, runnerSource);
  const agent = o.agent || 'claude-code';
  const node = o.node || process.execPath;
  const text = launcher.unixScript(agent, node, runner, { deadlineS: o.deadlineS === undefined ? 5 : o.deadlineS, deadlineSoft: true, lean: o.lean !== false });
  const file = path.join(dir, 'zn-hook-' + agent + '.sh');
  fs.writeFileSync(file, text, { mode: 0o755 });
  return { dir, runner, file, text };
}

function run(file, event, input = '{}') {
  const t0 = Date.now();
  const r = spawnSync('/bin/sh', [file, event], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' }, timeout: 20000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

const ACK = "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok');";
const CRASH = /its hook failed/;
const NOACK = /ended without confirming its answer/;
const CHANGED = /zn-gate changed since the hooks were installed/;
const GONE = /cannot start because the Node.js or the zn-gate files/;

// ---- the POSIX launchers do not change -------------------------------------------------------------------------------------

test('the POSIX launchers are byte for byte what they were before the lean launcher', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'launcher_posix_sha256.json'), 'utf8'));
  const seen = [];
  for (const agent of AGENTS) {
    for (const [name, o] of [['plain', {}], ['d13', { deadlineS: 13 }], ['d13soft', { deadlineS: 13, deadlineSoft: true }], ['d28', { deadlineS: 28 }]]) {
      const text = launcher.unixScript(agent, '/usr/bin/node', '/opt/zn/runner.js', { ...o, runnerDigest: 'a'.repeat(64) });
      assert.equal(crypto.createHash('sha256').update(text).digest('hex'), fixture[agent + '/' + name], agent + '/' + name);
      seen.push(agent + '/' + name);
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(fixture).sort());
});

test('writeLauncher writes the lean launcher on win32 only; every other platform keeps the full one', (t) => {
  const kinds = {};
  for (const platform of ['win32', 'linux', 'darwin']) {
    const home = tempDir(t, 'zn-b2342-w-');
    const env = { ZN_HOME: path.join(home, '.zn') };
    const file = launcher.writeLauncher('claude-code', process.execPath, REAL_RUNNER, { env, home, platform, deadlineS: 13, deadlineSoft: true });
    kinds[platform] = /^ZN_DEADLINE_S=13$/m.test(fs.readFileSync(file, 'utf8')) ? 'lean' : 'full';
  }
  assert.deepEqual(kinds, { win32: 'lean', linux: 'full', darwin: 'full' });
  // The caller can still force either one (tests do).
  const home = tempDir(t, 'zn-b2342-w-');
  const env = { ZN_HOME: path.join(home, '.zn') };
  const file = launcher.writeLauncher('claude-code', process.execPath, REAL_RUNNER, { env, home, platform: 'win32', lean: false, deadlineS: 13 });
  assert.match(fs.readFileSync(file, 'utf8'), /\/bin\/sleep 13 & ZN_SP=/);
});

test('the lean script starts no helper program: no mktemp, cat, rm, perl, sleep or setsid', () => {
  for (const agent of AGENTS) {
    const text = launcher.unixScript(agent, 'C:/n/node.exe', 'C:/z/runner.js', { deadlineS: 13, deadlineSoft: true, runnerDigest: 'a'.repeat(64), lean: true });
    const shell = text.split('\n').filter((l) => !/^ZN_(VERIFY|CFG)=/.test(l)).join('\n');
    assert.doesNotMatch(shell, /mktemp|\bcat\b|\bperl\b|\bsleep\b|\bsetsid\b|\/bin\/rm|\bwait\b|\$\(/, agent);
    assert.match(shell, /^ZN_SHA='a{64}'$/m);
    assert.match(shell, /^ZN_NODE='C:\/n\/node\.exe'$/m);
    assert.match(shell, /^ZN_RUNNER='C:\/z\/runner\.js'$/m);
  }
  assert.doesNotMatch(launcher.LEAN_JS, /\n/, 'the node code is one line');
});

// ---- behaviour (the real sh) -----------------------------------------------------------------------------------------------

test('lean: an answer with the confirmation passes through, with its status and stderr', { skip: !posix }, (t) => {
  const { file } = setup(t, ACK + "process.stdout.write('ANSWER\\n'); process.stderr.write('NOTE\\n'); process.exit(0);");
  const r = run(file, 'PreToolUse');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'ANSWER\n', 'NOTE\n']);
});

test('lean: a blocked call (status 2) is passed on with its reason, no confirmation needed', { skip: !posix }, (t) => {
  const { file } = setup(t, "process.stderr.write('zn: blocked\\n'); process.stdout.write('{\"x\":1}'); process.exit(2);");
  const r = run(file, 'PreToolUse');
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '{"x":1}', 'zn: blocked\n']);
});

test('lean: the runner gets its stdin, its agent as argv[2], ZN_HOOK_ACK and is the main module', { skip: !posix }, (t) => {
  const { file } = setup(t, ACK + "let s=''; process.stdin.on('data',(d)=>s+=d).on('end',()=>{ process.stdout.write(JSON.stringify({in:s,agent:process.argv[2],argc:process.argv.length,main:require.main===module,ack:!!process.env.ZN_HOOK_ACK})); process.exit(0); });");
  const input = JSON.stringify({ big: 'x'.repeat(200000) });
  const r = run(file, 'PreToolUse', input);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { in: input, agent: 'claude-code', argc: 3, main: true, ack: true });
});

test('lean: output through fs.writeSync and a write callback is held and passed on once', { skip: !posix }, (t) => {
  const { file } = setup(t, "const fs=require('fs'); fs.writeSync(1,'A'); fs.writeSync(1, Buffer.from('XBCX'), 1, 2); process.stdout.write('D', () => { fs.writeFileSync(process.env.ZN_HOOK_ACK,'ok'); process.exit(0); });");
  const r = run(file, 'PreToolUse');
  assert.deepEqual([r.status, r.stdout], [0, 'ABCD']);
});

test('lean: a runner that crashes after half an answer is blocked, the half answer is dropped', { skip: !posix }, (t) => {
  const { file } = setup(t, "process.stdout.write('HALF'); process.stderr.write('boom\\n'); process.exit(1);");
  let r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /HALF/);
  assert.match(r.stderr, CRASH);
  assert.match(r.stderr, /boom/, 'its stderr is still shown');
  r = run(file, 'PostToolUse');
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /NOT protecting this session: its hook failed/);
});

test('lean: an uncaught error in the runner is blocked', { skip: !posix }, (t) => {
  const { file } = setup(t, "process.stdout.write('HALF'); setTimeout(() => { throw new Error('late'); }, 10);");
  const r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /HALF/);
  assert.match(r.stderr, CRASH);
});

test('lean: a runner that ends with 0 without the confirmation is blocked', { skip: !posix }, (t) => {
  const { file } = setup(t, "process.stdout.write('UNCONFIRMED'); process.exit(0);");
  let r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /UNCONFIRMED/);
  assert.match(r.stderr, NOACK);
  r = run(file, 'PostToolUse');
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, NOACK);
});

test('lean: a runner that writes the confirmation file by path (not through ZN_HOOK_ACK) is not confirmed', { skip: !posix }, (t) => {
  const { file, dir } = setup(t, "require('fs').writeFileSync(require('path').join(__dirname,'ack'),'ok'); process.stdout.write('X'); process.exit(0);");
  const r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.match(r.stderr, NOACK);
  assert.ok(fs.existsSync(path.join(dir, 'ack')), 'other writes are not touched');
});

test('lean: a runner that runs past the deadline is blocked at the deadline, with nothing of its output', { skip: !posix }, (t) => {
  const { file } = setup(t, "process.stdout.write('PARTIAL'); process.stderr.write('slow\\n'); setInterval(() => {}, 1000);", { deadlineS: 1 });
  const r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.ok(r.ms >= 900 && r.ms < 6000, 'blocked at about 1 s, not at the test timeout: ' + r.ms);
  assert.doesNotMatch(r.stdout, /PARTIAL/);
  assert.match(r.stderr, CRASH);
  const p = run(file, 'PostToolUse');
  assert.equal(p.status, 0);
  assert.match(JSON.parse(p.stdout).systemMessage, /its hook failed/);
});

const BUSY = "const t = Date.now(); while (Date.now() - t < 5000) {} " + ACK + "process.stdout.write('LATE');";

test('lean: a runner that blocks its own thread past the deadline is blocked at the deadline, like the full launcher', { skip: !posix }, (t) => {
  const lean = setup(t, BUSY, { deadlineS: 2 });
  const full = setup(t, BUSY, { deadlineS: 2, lean: false });
  for (const [event, status] of [['PreToolUse', 2], ['PostToolUse', 0]]) {
    const a = run(lean.file, event);
    const b = run(full.file, event);
    assert.ok(a.ms >= 1800 && a.ms < 4500, 'lean answered at about the deadline, not after the 5 s block: ' + a.ms);
    assert.ok(b.ms >= 1800 && b.ms < 4500, 'full answered at about the deadline: ' + b.ms);
    assert.equal(a.status, status);
    assert.equal(a.status, b.status);
    assert.equal(a.stdout, b.stdout);
    assert.doesNotMatch(a.stdout, /LATE/);
    assert.match(a.stderr + a.stdout, /its hook failed/);
  }
});

test('lean: the runner reads its stdin in the worker and a normal call is unchanged', { skip: !posix }, (t) => {
  const { file } = setup(t, "let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => { " + ACK + "process.stdout.write('GOT:' + d + ':' + process.argv.slice(2).join(',')); });", { deadlineS: 20 });
  const r = run(file, 'PreToolUse', '{"a":1}');
  assert.deepEqual([r.status, r.stdout], [0, 'GOT:{"a":1}:claude-code']);
});

test('lean: the deadline timer does not hold back a runner that ends by itself', { skip: !posix }, (t) => {
  const { file } = setup(t, ACK + "process.stdout.write('FAST');", { deadlineS: 20 });
  const r = run(file, 'PreToolUse');
  assert.deepEqual([r.status, r.stdout], [0, 'FAST']);
  assert.ok(r.ms < 5000, 'ended at once: ' + r.ms);
});

test('lean: a tampered runner is not run, with the "changed" reason', { skip: !posix }, (t) => {
  const { file, runner, dir } = setup(t, ACK + "require('fs').writeFileSync(require('path').join(__dirname,'ran'),'1'); process.stdout.write('REAL'); process.exit(0);");
  for (const edit of [(s) => s + '\n// one more line\n', () => 'process.exit(0);\n']) {
    fs.writeFileSync(runner, edit(fs.readFileSync(runner, 'utf8')));
    const r = run(file, 'PreToolUse');
    assert.equal(r.status, 2);
    assert.match(r.stderr, CHANGED);
    assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(path.join(dir, 'ran')), 'nothing of it ran');
  }
  const post = run(file, 'PostToolUse');
  assert.equal(post.status, 0);
  assert.match(JSON.parse(post.stdout).systemMessage, CHANGED);
});

test('lean: a digest that is not 64 hex digits, or a runner that cannot be read, is "changed", never run', { skip: !posix }, (t) => {
  const { file, runner } = setup(t, ACK + "process.stdout.write('REAL');");
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^ZN_SHA='[0-9a-f]+'$/m, "ZN_SHA='abc'"));
  let r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.match(r.stderr, CHANGED);
  fs.unlinkSync(runner);
  r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.match(r.stderr, GONE, 'a missing runner file is the "gone" case of the shell');
});

test('lean: a Node.js that is gone blocks with the "gone" reason, nothing is run from the PATH', { skip: !posix }, (t) => {
  const { file, dir } = setup(t, ACK + "process.stdout.write('REAL');", { node: '/nonexistent/node-gone/bin/node' });
  fs.writeFileSync(path.join(dir, 'zn'), '#!/bin/sh\necho FROM_PATH\n', { mode: 0o755 });
  const env = { PATH: dir + ':' + process.env.PATH, HOME: '/nonexistent' };
  let r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env });
  assert.equal(r.status, 2);
  assert.match(r.stderr, GONE);
  assert.doesNotMatch(r.stdout, /FROM_PATH/);
  r = spawnSync('/bin/sh', [file, 'PostToolUse'], { input: '{}', encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /NOT protecting this session: its hook cannot start/);
});

test('lean: a "node" that cannot start, or that ends with 0 or 2 by itself, is a failure, not an answer', { skip: !posix }, (t) => {
  for (const body of ['#!/bin/sh\nexit 0\n', '#!/bin/sh\nexit 2\n', '#!/bin/sh\nexit 127\n', '#!/bin/sh\nkill -9 $$\n', 'not a program\n']) {
    const dir = tempDir(t, 'zn-b2342-stub-');
    const stub = path.join(dir, 'node');
    fs.writeFileSync(stub, body, { mode: 0o755 });
    const { file } = setup(t, ACK + "process.stdout.write('REAL');", { node: stub });
    const r = run(file, 'PreToolUse');
    assert.equal(r.status, 2, body);
    assert.match(r.stderr, CRASH, body);
    assert.doesNotMatch(r.stdout, /REAL/);
  }
});

test('lean: a NODE_OPTIONS that ends node with 0 before the code runs is not an answer', { skip: !posix }, (t) => {
  const { file, dir } = setup(t, ACK + "process.stdout.write('REAL');");
  fs.writeFileSync(path.join(dir, 'pre.js'), 'process.exit(0);\n');
  const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', NODE_OPTIONS: '--require ' + path.join(dir, 'pre.js') } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, CRASH);
});

test('lean: a runner that exits with the numbers the shell uses itself (80, 82, 86) is still a failure', { skip: !posix }, (t) => {
  for (const code of [80, 82, 86, 127, 143]) {
    const { file } = setup(t, ACK + "process.stdout.write('REAL'); process.exit(" + code + ');');
    const r = run(file, 'PreToolUse');
    assert.equal(r.status, 2, String(code));
    assert.match(r.stderr, CRASH, String(code));
    assert.doesNotMatch(r.stdout, /REAL/);
  }
});

// ---- the lean launcher answers like the full one --------------------------------------------------------------------------

// A blocking event by exit code, one by a decision on stdout (where the agent has one), and one that can only warn.
const EVENTS_BY_AGENT = (agent) => [...new Set([[...launcher.blockExit(agent)][0], [...launcher.blockJson(agent)][0], 'PostToolUse'])].filter(Boolean);

test('lean and full launchers give the same status, stdout and stderr for every agent, event and kind of failure', { skip: !posix }, (t) => {
  const cases = {
    crash: "process.stdout.write('HALF'); process.exit(1);",
    noack: "process.stdout.write('X'); process.exit(0);",
    ok: ACK + "process.stdout.write('OK\\n'); process.exit(0);",
    blocked: "process.stderr.write('why\\n'); process.stdout.write('J'); process.exit(2);",
    changed: ACK + "process.exit(0);",
  };
  let n = 0;
  for (const agent of AGENTS) {
    for (const [kind, source] of Object.entries(cases)) {
      const full = setup(t, source, { agent, lean: false });
      const lean = setup(t, source, { agent, lean: true });
      if (kind === 'changed') for (const s of [full, lean]) fs.writeFileSync(s.runner, 'process.exit(0);\n');
      for (const event of EVENTS_BY_AGENT(agent)) {
        const a = run(full.file, event);
        const b = run(lean.file, event);
        assert.deepEqual({ status: b.status, stdout: b.stdout, stderr: b.stderr }, { status: a.status, stdout: a.stdout, stderr: a.stderr }, agent + ' ' + kind + ' ' + event);
        n++;
      }
    }
  }
  assert.ok(n >= 80, String(n));
});

test('lean and full launchers agree when Node.js is gone', { skip: !posix }, (t) => {
  for (const agent of AGENTS) {
    const full = setup(t, ACK, { agent, lean: false, node: '/nonexistent/node' });
    const lean = setup(t, ACK, { agent, lean: true, node: '/nonexistent/node' });
    for (const event of EVENTS_BY_AGENT(agent)) {
      const a = run(full.file, event);
      const b = run(lean.file, event);
      assert.deepEqual({ status: b.status, stdout: b.stdout, stderr: b.stderr }, { status: a.status, stdout: a.stdout, stderr: a.stderr }, agent + ' ' + event);
    }
  }
});

test('lean: the real runner answers the same as running it directly, also for a blocked call', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-b2342-h-');
  const cwd = tempDir(t, 'zn-b2342-cwd-');
  const env = { PATH: process.env.PATH, HOME: home, ZN_HOME: path.join(home, '.zn'), ZN_STATS: 'off', ZN_NO_TELEMETRY: '1' };
  const digest = launcher.runnerSha(REAL_RUNNER);
  const file = path.join(home, 'zn-hook-claude-code.sh');
  fs.writeFileSync(file, launcher.unixScript('claude-code', process.execPath, REAL_RUNNER, { deadlineS: 13, deadlineSoft: true, runnerDigest: digest, lean: true }), { mode: 0o755 });
  for (const command of ['ls -la', 'cat ~/.ssh/id_rsa']) {
    const input = JSON.stringify({ session_id: 'b2342', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1' });
    const direct = spawnSync(process.execPath, [REAL_RUNNER, 'claude-code'], { input, encoding: 'utf8', env, cwd });
    const viaLean = spawnSync('/bin/sh', [file, 'PreToolUse'], { input, encoding: 'utf8', env, cwd });
    assert.equal(viaLean.status, direct.status, command + ' status: ' + viaLean.stderr);
    assert.equal(viaLean.stdout, direct.stdout, command + ' stdout');
    assert.equal(viaLean.stderr, direct.stderr, command + ' stderr');
    if (command !== 'ls -la') assert.match(direct.stdout, /"permissionDecision":"deny"/, 'the blocked call is really blocked');
    else assert.doesNotMatch(direct.stdout, /deny/);
  }
});

// ---- refresh and the adapters keep it -------------------------------------------------------------------------------------

test('refresh moves a full launcher to the lean one on Windows and keeps its deadline; the lean one is stable', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-b2342-r-');
  const env = { ZN_HOME: path.join(home, '.zn') };
  const runner = path.join(tempDir(t, 'zn-b2342-pkg-'), 'runner.js');
  fs.writeFileSync(runner, ACK);
  const file = launcher.writeLauncher('claude-code', process.execPath, runner, { env, home, platform: 'linux', deadlineS: 9, deadlineSoft: true, runnerDigest: '00'.repeat(32) });
  assert.match(fs.readFileSync(file, 'utf8'), /\/bin\/sleep 9 & ZN_SP=/);
  const out = [];
  refresh.main({ env, home, runnerPath: runner, platform: 'win32', global: false, out: (s) => out.push(s) });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^ZN_DEADLINE_S=9$/m);
  assert.match(text, new RegExp("^ZN_SHA='" + launcher.runnerSha(runner) + "'$", 'm'));
  assert.deepEqual(out, ['zn-gate: refreshed hook launchers for claude-code\n']);
  refresh.main({ env, home, runnerPath: runner, platform: 'win32', global: false, out: (s) => out.push(s) });
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'a second refresh changes nothing');
  assert.equal(out.length, 1);
});

test('the Claude Code install on win32 writes the lean launcher and `zn-gate check` can read its node and runner back', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-b2342-i-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  getAdapter('claude-code').install({ env, home, platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: 'C:\\zn\\lib\\hooks\\runner.js', mcp: false });
  const text = fs.readFileSync(launcher.launcherFile('claude-code', { env, home }), 'utf8');
  assert.match(text, /^ZN_NODE='C:\/Program Files\/nodejs\/node\.exe'$/m);
  assert.match(text, /^ZN_RUNNER='C:\/zn\/lib\/hooks\/runner\.js'$/m);
  assert.match(text, /^ZN_DEADLINE_S=\d+$/m);
});
