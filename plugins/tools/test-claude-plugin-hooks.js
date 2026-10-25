#!/usr/bin/env node
'use strict';

/**
 * Tests for how the Claude Code plugin (plugins/zn-gate/hooks/hooks.json) starts Node.js: only from an absolute PATH entry,
 * through scripts/zn-node.sh, so a `node` placed in the project folder (a relative or empty PATH entry, or the current
 * folder) is never run. The hook command is taken from hooks.json and run the way Claude Code runs it (`sh -c`), in a
 * project folder that holds the planted programs. Claude Code itself is not needed here.
 *
 *   node plugins/tools/test-claude-plugin-hooks.js     (from the repository root)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'zn-gate');
const posix = process.platform !== 'win32';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-claude-plugin-hooks-')));
let n = 0;
function test(name, fn) {
  fn();
  n++;
  process.stdout.write('ok ' + n + ' - ' + name + '\n');
}

const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
function commandFor(event, pluginRoot) {
  const h = hooks[event][0].hooks[0];
  return { command: h.command.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot), spec: h };
}
const NODE_SH = path.join(PLUGIN, 'scripts', 'zn-node.sh');

try {
  test('every hook starts through scripts/zn-node.sh with its own event name, never `node` by name', () => {
    for (const [event, groups] of Object.entries(hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          assert.ok(!/^\s*node\b/.test(h.command), event + ': starts node by name: ' + h.command);
          const mode = event === 'SessionStart' ? 'check claude-code' : 'hook claude-code';
          assert.strictEqual(h.command, '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" ' + event + ' ' + mode, event);
        }
      }
    }
    assert.ok(fs.existsSync(NODE_SH), 'scripts/zn-node.sh exists');
    assert.ok(fs.readFileSync(NODE_SH, 'utf8').startsWith('#!/bin/sh\n'));
    // The blocking events keep onFailure "block".
    for (const event of ['PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion']) assert.strictEqual(hooks[event][0].hooks[0].onFailure, 'block', event);
  });

  if (!posix) {
    process.stdout.write('ok ' + (++n) + ' - hook behaviour # SKIP POSIX shell script\n');
  } else {
    // A plugin folder: a stub launcher that prints its arguments and stdin and exits as told, and the script under test.
    const STUB = '"use strict";\nlet d="";process.stdin.on("data",(c)=>{d+=c;});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:d}));process.exitCode=Number(process.env.ZN_STUB_RC||0);});\n';
    function plugin(name, { script = NODE_SH, patch } = {}) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'zn-launch.js'), STUB);
      if (fs.existsSync(script)) {
        let t = fs.readFileSync(script, 'utf8');
        if (patch) t = patch(t);
        fs.writeFileSync(path.join(dir, 'scripts', 'zn-node.sh'), t);
      }
      return dir;
    }
    // The real Node.js, reachable through an absolute folder.
    const realbin = path.join(tmp, 'realbin');
    fs.mkdirSync(realbin);
    fs.symlinkSync(process.execPath, path.join(realbin, 'node'));
    const emptybin = path.join(tmp, 'emptybin');
    fs.mkdirSync(emptybin);
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);

    function run(dir, event, { cwd, PATH, input, env = {} }) {
      const { command } = commandFor(event, dir);
      return spawnSync('/bin/sh', ['-c', command], {
        cwd, input: input === undefined ? '{"hook_event_name":"' + event + '"}' : input, encoding: 'utf8', timeout: 60000,
        env: { PATH, HOME: home, ...env },
      });
    }
    function project(name, marker) {
      const work = path.join(tmp, name);
      fs.mkdirSync(path.join(work, 'bin'), { recursive: true });
      for (const d of [work, path.join(work, 'bin')]) {
        for (const p of ['node', 'node.exe', 'sh', 'sleep']) fs.writeFileSync(path.join(d, p), '#!/bin/sh\n: > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
      }
      return work;
    }

    test('a node planted in the project folder is never run (relative, empty and current-folder PATH entries)', () => {
      const d = plugin('planted');
      const marker = path.join(tmp, 'planted-ran');
      const work = project('planted-work', marker);
      const expected = JSON.stringify({ args: ['hook', 'claude-code'], stdin: '{"hook_event_name":"PreToolUse"}' });
      const paths = [
        '.:' + realbin, ':' + realbin, 'bin:' + realbin, realbin + ':.', realbin + ':', '.:/usr/bin:/bin:' + realbin,
        ':/usr/bin:/bin', 'bin:/usr/bin:/bin', '.:/usr/bin:/bin',
      ];
      for (const PATH of paths) {
        const r = run(d, 'PreToolUse', { cwd: work, PATH });
        assert.strictEqual(fs.existsSync(marker), false, JSON.stringify(PATH) + ': a planted program ran');
        // The system node exists on most machines (/usr/bin/node), so those paths still reach the launcher; the stub answer is the normal one.
        if (r.status === 0) assert.strictEqual(r.stdout, expected, JSON.stringify(PATH));
      }
      for (const PATH of ['.:' + realbin, ':' + realbin, 'bin:' + realbin, realbin + ':.']) {
        const r = run(d, 'PreToolUse', { cwd: work, PATH });
        assert.strictEqual(r.status, 0, PATH + ': ' + r.stderr);
        assert.strictEqual(r.stdout, expected, PATH);
      }
    });

    test('the real launcher gives the same answer with and without a planted node (relative PATH entries)', () => {
      const dir = path.join(tmp, 'real-plugin');
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      for (const f of ['zn-launch.js', 'zn-gate.lock.json']) fs.copyFileSync(path.join(PLUGIN, 'scripts', f), path.join(dir, 'scripts', f));
      if (fs.existsSync(NODE_SH)) fs.copyFileSync(NODE_SH, path.join(dir, 'scripts', 'zn-node.sh'));
      const marker = path.join(tmp, 'real-planted-ran');
      const work = project('real-work', marker);
      const input = '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}';
      const clean = run(dir, 'PreToolUse', { cwd: work, PATH: realbin, input });
      for (const PATH of ['.:' + realbin, ':' + realbin, 'bin:' + realbin]) {
        const r = run(dir, 'PreToolUse', { cwd: work, PATH, input });
        assert.strictEqual(fs.existsSync(marker), false, PATH + ': a planted program ran');
        assert.strictEqual(r.status, clean.status, PATH);
        assert.strictEqual(r.stdout, clean.stdout, PATH);
        assert.strictEqual(r.stderr, clean.stderr, PATH);
      }
    });

    // No Node.js anywhere usable: the usual install folders are removed from a test copy (the machine may have one).
    const noFallback = (t) => t.replace('for c in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node "/c/Program Files/nodejs/node.exe" ', 'for c in ');
    test('with no usable Node.js the blocking events block (exit 2) and the others only warn', () => {
      const text = fs.readFileSync(NODE_SH, 'utf8');
      assert.notStrictEqual(noFallback(text), text, 'the test copy removes the install folders');
      const d = plugin('nonode', { patch: noFallback });
      const marker = path.join(tmp, 'nonode-ran');
      const work = project('nonode-work', marker);
      for (const PATH of [emptybin, '.:' + emptybin, 'bin:' + emptybin + ':']) {
        for (const event of ['PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion']) {
          const r = run(d, event, { cwd: work, PATH });
          assert.strictEqual(r.status, 2, event + ' ' + PATH + ': ' + r.stderr);
          assert.ok(/^zn: no Node\.js was found/.test(r.stderr), r.stderr);
        }
        for (const event of ['PostToolUse', 'SessionStart']) {
          const r = run(d, event, { cwd: work, PATH });
          assert.strictEqual(r.status, 0, event);
          assert.ok(/NOT protecting this session/.test(JSON.parse(r.stdout).systemMessage), r.stdout);
        }
        assert.strictEqual(fs.existsSync(marker), false, 'a planted program ran');
      }
    });

    test('a missing launcher blocks a blocking event', () => {
      const d = plugin('nolauncher');
      fs.rmSync(path.join(d, 'scripts', 'zn-launch.js'));
      const r = run(d, 'PreToolUse', { cwd: tmp, PATH: realbin });
      assert.strictEqual(r.status, 2);
      assert.ok(/zn-launch\.js\) is missing/.test(r.stderr), r.stderr);
    });

    test('the exit code and the output of the launcher pass through unchanged', () => {
      const d = plugin('pass');
      for (const rc of ['0', '2', '1', '7']) {
        for (const event of ['PreToolUse', 'PostToolUse']) {
          const r = run(d, event, { cwd: tmp, PATH: realbin, env: { ZN_STUB_RC: rc } });
          assert.strictEqual(r.status, Number(rc), event + ' rc ' + rc);
          assert.strictEqual(r.stdout, JSON.stringify({ args: ['hook', 'claude-code'], stdin: '{"hook_event_name":"' + event + '"}' }), event);
          assert.strictEqual(r.stderr, '');
        }
      }
      const c = run(d, 'SessionStart', { cwd: tmp, PATH: realbin });
      assert.strictEqual(c.stdout, JSON.stringify({ args: ['check', 'claude-code'], stdin: '{"hook_event_name":"SessionStart"}' }));
      // A large event (tool output) reaches the launcher whole.
      const big = '{"hook_event_name":"PostToolUse","x":"' + 'a'.repeat(300000) + '"}';
      const b = run(d, 'PostToolUse', { cwd: tmp, PATH: realbin, input: big });
      assert.strictEqual(JSON.parse(b.stdout).stdin.length, big.length);
    });

    test('only absolute PATH entries reach the launcher', () => {
      const d = plugin('pathpass');
      const probe = path.join(tmp, 'path-probe');
      fs.mkdirSync(probe);
      fs.writeFileSync(path.join(probe, 'node'), '#!/bin/sh\nprintf "%s" "$PATH"\n', { mode: 0o755 });
      const r = run(d, 'PreToolUse', { cwd: tmp, PATH: '.:' + probe + ':bin::/usr/bin' });
      assert.strictEqual(r.stdout, probe + ':/usr/bin');
    });

    test('a Node.js that hangs is stopped at the start deadline: block, or warn on PostToolUse', () => {
      const text = fs.readFileSync(NODE_SH, 'utf8');
      assert.ok(/^DEADLINE=13$/m.test(text) && 13 < 15, 'the deadline is under the 15-second hook timeout');
      const d = plugin('hang', { patch: (t) => t.replace(/^DEADLINE=13$/m, 'DEADLINE=2') });
      const hang = path.join(tmp, 'hangbin');
      fs.mkdirSync(hang);
      fs.writeFileSync(path.join(hang, 'node'), '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
      const t0 = Date.now();
      const r = run(d, 'PreToolUse', { cwd: tmp, PATH: hang + ':/usr/bin:/bin' });
      const ms = Date.now() - t0;
      assert.strictEqual(r.status, 2, r.stderr);
      assert.ok(/did not finish starting within 2 seconds/.test(r.stderr), r.stderr);
      assert.ok(ms >= 1500 && ms < 20000, 'answered at the deadline: ' + ms + ' ms');
      const p = run(d, 'PostToolUse', { cwd: tmp, PATH: hang + ':/usr/bin:/bin' });
      assert.strictEqual(p.status, 0);
      assert.ok(/NOT protecting/.test(p.stdout), p.stdout);
    });
  }

  process.stdout.write('1..' + n + '\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
