'use strict';

// A hook whose answer never reached the agent must not count as done (a status 0 with no answer is a fail-open):
//  - a failed write on the hook's stdout (EPIPE) ends with a non-zero status, never 0;
//  - the launchers accept a status 0 only when the hook confirmed (ZN_HOOK_ACK) that it wrote its whole answer;
//    a runner that stops half way (prints "{", exits 0) is a failure and ends in the launcher's own block.
// Values are fake. Everything runs in a temporary home.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const RUNNER = path.join(ROOT, 'lib', 'hooks', 'runner.js');
const posix = process.platform !== 'win32';

// A Claude Code PreToolUse event that zn answers with a deny on stdout: reading zn's own config file.
function denyEvent(home) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(home, '.zn', 'config.json') } };
}

function runNode(args, { home, input, closeRead, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (closeRead) child.stdout.destroy();
    else child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const ENTRIES = [
  ['bin/cli.js hook', (agent) => [CLI, 'hook', agent]],
  ['lib/hooks/runner.js', (agent) => [RUNNER, agent]],
];

for (const [label, argsOf] of ENTRIES) {
  test('hook (' + label + '): a stdout that closed before the answer is written is a failure: status 1 under a launcher, never 0', async (t) => {
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const ack = path.join(tempDir(t, 'zn-ov-ack-'), 'ack');
    fs.writeFileSync(ack, '');
    const input = JSON.stringify(denyEvent(home));
    const closed = await runNode(argsOf('claude-code'), { home, input, closeRead: true, env: { ZN_HOOK_ACK: ack } });
    assert.equal(closed.signal, null);
    assert.equal(closed.code, 1, 'EPIPE on the answer: status 1 (the launcher then blocks)');
    assert.equal(fs.readFileSync(ack, 'utf8'), '', 'no confirmation for an answer that was not written');
    assert.doesNotMatch(closed.stderr, /^\s+at /m, 'no stack trace');
  });

  test('hook (' + label + '): a stdout that closed early with no launcher: exit 2 (the documented block) on a blocking event', async (t) => {
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const input = JSON.stringify(denyEvent(home));
    const closed = await runNode(argsOf('claude-code'), { home, input, closeRead: true });
    assert.equal(closed.code, 2);
  });

  test('hook (' + label + '): normal path: the answer is written, status 0 and the confirmation is in the ack file', async (t) => {
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const ack = path.join(tempDir(t, 'zn-ov-ack-'), 'ack');
    fs.writeFileSync(ack, '');
    const input = JSON.stringify(denyEvent(home));
    const r = await runNode(argsOf('claude-code'), { home, input, closeRead: false, env: { ZN_HOOK_ACK: ack } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"permissionDecision":\s*"deny"/);
    assert.equal(fs.readFileSync(ack, 'utf8'), 'ok');
    // An allowed call prints nothing and is confirmed all the same.
    const fine = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(home, 'notes.txt') } };
    fs.writeFileSync(ack, '');
    const r2 = await runNode(argsOf('claude-code'), { home, input: JSON.stringify(fine), closeRead: false, env: { ZN_HOOK_ACK: ack } });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.stdout, '');
    assert.equal(fs.readFileSync(ack, 'utf8'), 'ok');
  });
}

test('hook: a refusal (exit 2) writes no confirmation and keeps its status', async (t) => {
  const home = tempDir(t, 'zn-ov-home-');
  const ack = path.join(tempDir(t, 'zn-ov-ack-'), 'ack');
  fs.writeFileSync(ack, '');
  const r = await runNode([RUNNER, 'claude-code'], { home, input: 'not json', env: { ZN_HOOK_ACK: ack } });
  assert.equal(r.code, 2);
  assert.equal(fs.readFileSync(ack, 'utf8'), '');
});

// ---- the POSIX launcher ----

function writeScript(t, agent, runnerBody, opts = {}) {
  const dir = tempDir(t, 'zn-ov-launch-');
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, runnerBody);
  const file = path.join(dir, 'launcher.sh');
  fs.writeFileSync(file, launcher.unixScript(agent, process.execPath, runner, opts), { mode: 0o755 });
  return file;
}

function runLauncher(file, event, input, { closeRead = false } = {}) {
  if (!closeRead) return Promise.resolve(spawnSync('/bin/sh', [file, event], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } }));
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [file, event], { env: { PATH: process.env.PATH, HOME: '/nonexistent' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.destroy();
    child.stderr.on('data', (b) => { stderr += b; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => resolve({ status: code, stderr }));
  });
}

const PARTIAL = "process.stdout.write('{');\n";
const EMPTY_NO_ACK = "\n";
const GOOD = "process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }));\nrequire('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok');\n";
const ALLOW = "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok');\n";

for (const [name, opts] of [['plain', {}], ['with a deadline', { deadlineS: 5 }]]) {
  test('posix launcher (' + name + '): a runner that prints "{" and exits 0 is a failure: a blocking event is blocked with the repair message', { skip: !posix }, async (t) => {
    const file = writeScript(t, 'claude-code', PARTIAL, opts);
    for (const ev of ['PreToolUse', 'UserPromptSubmit']) {
      const r = await runLauncher(file, ev, '{}');
      assert.equal(r.status, 2, ev);
      assert.match(r.stderr, /so this was blocked/);
      assert.doesNotMatch(r.stdout, /^\{$/m, 'the half answer is not passed on');
    }
    const post = await runLauncher(file, 'PostToolUse', '{}');
    assert.equal(post.status, 0);
    assert.match(JSON.parse(post.stdout).systemMessage, /NOT protecting this session/);
  });

  test('posix launcher (' + name + '): an empty answer with no confirmation is blocked; the same answer with the confirmation is an allow', { skip: !posix }, async (t) => {
    const bad = writeScript(t, 'claude-code', EMPTY_NO_ACK, opts);
    const r = await runLauncher(bad, 'PreToolUse', '{}');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /so this was blocked/);
    const ok = writeScript(t, 'claude-code', ALLOW, opts);
    const r2 = await runLauncher(ok, 'PreToolUse', '{}');
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stdout, '');
  });

  test('posix launcher (' + name + '): a confirmed full answer passes through unchanged', { skip: !posix }, async (t) => {
    const file = writeScript(t, 'claude-code', GOOD, opts);
    const r = await runLauncher(file, 'PreToolUse', '{}');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  test('posix launcher (' + name + '): the Daybreak case: the real runner cannot write its answer (EPIPE), so the launcher blocks instead of accepting status 0', { skip: !posix }, async (t) => {
    const dir = tempDir(t, 'zn-ov-real-');
    const file = path.join(dir, 'launcher.sh');
    fs.writeFileSync(file, launcher.unixScript('claude-code', process.execPath, RUNNER, opts), { mode: 0o755 });
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const r = await new Promise((resolve) => {
      const child = spawn('/bin/sh', [file, 'PreToolUse'], { env: { PATH: process.env.PATH, HOME: home, ZN_STATS: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.destroy();
      let stderr = '';
      child.stderr.on('data', (b) => { stderr += b; });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(denyEvent(home)));
      child.on('close', (code) => resolve({ status: code, stderr }));
    });
    assert.equal(r.status, 2, 'before the fix this was 0: the deny never reached the agent and the call ran');
    assert.match(r.stderr, /so this was blocked/);
  });
}

test('posix launcher: the confirmation file is removed when the launcher ends', { skip: !posix }, async (t) => {
  const tmp = tempDir(t, 'zn-ov-tmp-');
  const file = writeScript(t, 'claude-code', GOOD);
  for (const body of [GOOD, PARTIAL]) {
    fs.writeFileSync(path.join(path.dirname(file), 'runner.js'), body);
    const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', TMPDIR: tmp } });
    assert.ok(r.status === 0 || r.status === 2);
    assert.deepEqual(fs.readdirSync(tmp), []);
  }
});

test('posix launcher: no confirmation file possible (unwritable temp folder): nothing is accepted as done, the call is blocked', { skip: !posix }, (t) => {
  const file = writeScript(t, 'claude-code', GOOD);
  const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', TMPDIR: '/nonexistent/zn-no-tmp' } });
  assert.equal(r.status, 2);
});

test('posix launcher: Antigravity (deny JSON on stdout) with a runner that prints "{": the launcher prints its own complete deny JSON', { skip: !posix }, async (t) => {
  const file = writeScript(t, 'antigravity', PARTIAL);
  const r = await runLauncher(file, 'PreToolUse', '{}');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, 'deny');
});

// ---- the Windows launcher: the text, and real PowerShell where there is one ----

test('windows launcher: a status 0 is accepted only with the confirmation (zk), and every exit removes the file', () => {
  for (const [agent, ev] of [['claude-code', 'PreToolUse'], ['codex', 'PreToolUse'], ['cursor', 'beforeShellExecution'], ['gemini', 'BeforeTool']]) {
    for (const deadlineS of [0, 5]) {
      const s = launcher.windowsScript(agent, ev, 'C:/node/node.exe', 'C:/z/runner.js', { deadlineS });
      assert.match(s, /ZN_HOOK_ACK/, agent);
      assert.ok(!/\$(LASTEXITCODE|rc) -eq 0 -or/.test(s), agent + ': no bare 0 check');
      assert.ok(/\(\$(LASTEXITCODE|rc) -eq 0 -and \(zk\)\)/.test(s), agent + ': 0 needs zk');
      assert.match(s, /exit [02] # zn hook /);
    }
  }
});

test('windows (real PowerShell): a runner that prints "{" and exits 0 does not count as an answer', { skip: process.platform !== 'win32' }, (t) => {
  const { windowsCommandScript } = require('../lib/shell-quote');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const winPath = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), path.dirname(ps)].join(';');
  for (const deadlineS of [0, 5]) {
    const dir = tempDir(t, 'zn-ov-win-');
    const partial = path.join(dir, 'partial.js');
    fs.writeFileSync(partial, "process.stdout.write('{');\n");
    const good = path.join(dir, 'good.js');
    fs.writeFileSync(good, "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok');\n");
    const run = (runner) => {
      const script = launcher.windowsScript('claude-code', 'PreToolUse', process.execPath.replace(/\\/g, '/'), runner.replace(/\\/g, '/'), { deadlineS });
      return spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { input: '{}', encoding: 'utf8', env: { ...process.env, PATH: winPath } });
    };
    const bad = run(partial);
    assert.equal(bad.status, 2, 'deadline ' + deadlineS + ': ' + bad.stdout + bad.stderr);
    assert.match(bad.stderr, /so this was blocked/);
    const ok = run(good);
    assert.equal(ok.status, 0, 'deadline ' + deadlineS + ': ' + ok.stderr);
    void windowsCommandScript;
  }
});

for (const [name, opts] of [['plain', {}], ['with a deadline', { deadlineS: 5 }]]) {
  test('posix launcher (' + name + '): the Daybreak case through `zn hook` (bin/cli.js): EPIPE on the answer is blocked, not accepted as status 0', { skip: !posix }, async (t) => {
    const dir = tempDir(t, 'zn-ov-cli-');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\nexec "' + process.execPath + '" "' + CLI + '" "$@"\n', { mode: 0o755 });
    const file = path.join(dir, 'launcher.sh');
    // The recorded runner is gone, so the launcher runs `zn hook` from the PATH (the Daybreak repro).
    fs.writeFileSync(file, launcher.unixScript('claude-code', '/nonexistent/node-gone/bin/node', '/nonexistent/runner.js', opts), { mode: 0o755 });
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const run = (closeRead) => new Promise((resolve) => {
      const child = spawn('/bin/sh', [file, 'PreToolUse'], { env: { PATH: bin + ':/usr/bin:/bin', HOME: home, ZN_STATS: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      if (closeRead) child.stdout.destroy();
      else child.stdout.on('data', (b) => { stdout += b; });
      child.stderr.on('data', (b) => { stderr += b; });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(denyEvent(home)));
      child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
    const closed = await run(true);
    assert.equal(closed.status, 2, 'before the fix this was 0: zn hook swallowed the EPIPE and the launcher accepted it');
    assert.match(closed.stderr, /so this was blocked/);
    const normal = await run(false);
    assert.equal(normal.status, 0, normal.stderr);
    assert.match(normal.stdout, /"permissionDecision":\s*"deny"/);
  });
}

// ---- predictable temporary names (no mktemp): a FIFO or link planted at the name is never used ----

function noMktempScript(t, runnerBody) {
  const file = writeScript(t, 'claude-code', runnerBody);
  const text = fs.readFileSync(file, 'utf8').replace('/usr/bin/mktemp /bin/mktemp', '/nonexistent/mktemp');
  assert.ok(text.includes('/nonexistent/mktemp'));
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
}

function runPlanted(file, tmp, plant) {
  // `exec` keeps the PID, so the names the launcher would try first are known before it runs.
  const wrapper = 'for n in ack out; do ' + plant + '; done; exec /bin/sh "$0" PreToolUse';
  return spawnSync('/bin/sh', ['-c', wrapper, file], { input: '{}', encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: '/nonexistent', TMPDIR: tmp } });
}

test('posix launcher (no mktemp): a FIFO and a link planted at the predictable names are skipped; the answer is the runner\'s', { skip: !posix }, (t) => {
  const tmp = tempDir(t, 'zn-ov-plant-');
  const file = noMktempScript(t, GOOD);
  const r = runPlanted(file, tmp, 'mkfifo "$TMPDIR/zn-$n.$$.1"; ln -s /dev/null "$TMPDIR/zn-$n.$$.2"');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { permissionDecision: 'deny' } });
});

test('posix launcher (no mktemp): every name taken by a FIFO: blocked at once, no hang', { skip: !posix }, (t) => {
  const tmp = tempDir(t, 'zn-ov-plant-');
  const file = noMktempScript(t, GOOD);
  const r = runPlanted(file, tmp, 'for i in 1 2 3 4 5 6; do mkfifo "$TMPDIR/zn-$n.$$.$i"; done');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /so this was blocked/);
});

test('posix launcher (with mktemp): a FIFO at the old predictable name changes nothing', { skip: !posix }, (t) => {
  const tmp = tempDir(t, 'zn-ov-plant-');
  const file = writeScript(t, 'claude-code', GOOD);
  const r = runPlanted(file, tmp, 'mkfifo "$TMPDIR/zn-$n.$$.1"');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('posix launcher: a status 0 without the confirmation (an older zn on the PATH) gets its own message that says how to fix it', { skip: !posix }, async (t) => {
  const file = writeScript(t, 'claude-code', EMPTY_NO_ACK);
  const r = await runLauncher(file, 'PreToolUse', '{}');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /older than this hook/);
  assert.match(r.stderr, /npm install -g zn-gate.*zn hooks install claude-code/);
  const post = await runLauncher(file, 'PostToolUse', '{}');
  assert.match(JSON.parse(post.stdout).systemMessage, /zn hooks install claude-code/);
});
