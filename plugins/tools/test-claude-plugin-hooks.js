#!/usr/bin/env node
'use strict';

/**
 * Tests for how the zn-gate plugin hooks start Node.js. Claude Code (plugins/zn-gate/hooks/hooks.json) and Codex
 * (com.openai/hooks.json) run hooks in the project folder, so they start Node.js only from an absolute PATH entry, through
 * scripts/zn-node.sh, and a `node` placed in the project folder (a relative or empty PATH entry, or the current folder) is
 * never run. There is no Cursor plugin any more (check-plugins.js fails if its manifests come back).
 * The hook command is taken from the manifest and run through `sh -c` (and `bash -c`). No agent is needed here.
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
// event -> command of the Codex manifest (com.openai/hooks.json).
function manifestCommands(file) {
  const out = {};
  for (const [event, groups] of Object.entries(JSON.parse(fs.readFileSync(path.join(PLUGIN, file), 'utf8')).hooks)) {
    for (const g of groups) for (const h of (g.hooks || [g])) out[event] = h.command;
  }
  return out;
}

try {
  test('Claude Code and Codex hooks start through scripts/zn-node.sh with their own event name; no Cursor plugin', () => {
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
    for (const [event, c] of Object.entries(manifestCommands('com.openai/hooks.json'))) {
      assert.strictEqual(c, '/bin/sh "$PLUGIN_ROOT/scripts/zn-node.sh" ' + event + ' hook codex', 'codex ' + event);
    }
    // The Cursor plugin is no longer offered: its hooks started node by name (zn hooks install cursor instead).
    for (const f of [path.join(ROOT, '.cursor-plugin'), path.join(PLUGIN, '.cursor-plugin'), path.join(PLUGIN, 'cursor')]) {
      assert.strictEqual(fs.existsSync(f), false, f);
    }
    for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) assert.strictEqual(h.shell, 'bash', h.command);
    const codexWin = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'com.openai', 'hooks.json'), 'utf8')).hooks;
    for (const [event, groups] of Object.entries(codexWin)) {
      const w = groups[0].hooks[0].commandWindows;
      if (event === 'PostToolUse') assert.ok(/^echo \{"systemMessage":"zn is NOT protecting this session: /.test(w), w);
      else assert.ok(/ 1>&2 & exit 2$/.test(w) && /does not run on Windows/.test(w), event + ': ' + w);
    }
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
    // A folder to run in that holds none of the programs above: the folder a hook runs in is never trusted for programs.
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);

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
      const r = run(d, 'PreToolUse', { cwd: elsewhere, PATH: realbin });
      assert.strictEqual(r.status, 2);
      assert.ok(/zn-launch\.js\) is missing/.test(r.stderr), r.stderr);
    });

    test('the exit code and the output of the launcher pass through unchanged', () => {
      const d = plugin('pass');
      for (const rc of ['0', '2', '1', '7']) {
        for (const event of rc === '0' || rc === '2' ? ['PreToolUse', 'PostToolUse'] : ['PostToolUse']) {
          const r = run(d, event, { cwd: elsewhere, PATH: realbin, env: { ZN_STUB_RC: rc } });
          assert.strictEqual(r.status, Number(rc), event + ' rc ' + rc);
          assert.strictEqual(r.stdout, JSON.stringify({ args: ['hook', 'claude-code'], stdin: '{"hook_event_name":"' + event + '"}' }), event);
          assert.strictEqual(r.stderr, '');
        }
      }
      const c = run(d, 'SessionStart', { cwd: elsewhere, PATH: realbin });
      assert.strictEqual(c.stdout, JSON.stringify({ args: ['check', 'claude-code'], stdin: '{"hook_event_name":"SessionStart"}' }));
      // A large event (tool output) reaches the launcher whole.
      const big = '{"hook_event_name":"PostToolUse","x":"' + 'a'.repeat(300000) + '"}';
      const b = run(d, 'PostToolUse', { cwd: elsewhere, PATH: realbin, input: big });
      assert.strictEqual(JSON.parse(b.stdout).stdin.length, big.length);
    });

    test('a launcher that fails (exit 1, 7, 137) on a blocking event is refused (exit 2) for Claude Code and Codex', () => {
      const d = plugin('fail');
      for (const rc of ['1', '7', '137']) {
        for (const event of ['PreToolUse', 'UserPromptSubmit']) {
          const r = run(d, event, { cwd: elsewhere, PATH: realbin, env: { ZN_STUB_RC: rc } });
          assert.strictEqual(r.status, 2, event + ' rc ' + rc + ': ' + r.stderr);
          assert.ok(r.stderr.startsWith('zn: the hook ended with exit code ' + rc + '. This call was blocked'), r.stderr);
        }
        const codex = spawnSync('/bin/sh', [path.join(d, 'scripts', 'zn-node.sh'), 'PreToolUse', 'hook', 'codex'], {
          cwd: elsewhere, input: '{}', encoding: 'utf8', timeout: 60000, env: { PATH: realbin, HOME: home, ZN_STUB_RC: rc },
        });
        assert.strictEqual(codex.status, 2, 'codex rc ' + rc + ': ' + codex.stderr);
        assert.ok(/turn off the zn-gate plugin in Codex/.test(codex.stderr), codex.stderr);
      }
    });

    test('only absolute PATH entries reach the launcher', () => {
      const d = plugin('pathpass');
      const probe = path.join(tmp, 'path-probe');
      fs.mkdirSync(probe);
      fs.writeFileSync(path.join(probe, 'node'), '#!/bin/sh\nprintf "%s" "$PATH"\n', { mode: 0o755 });
      const r = run(d, 'PreToolUse', { cwd: elsewhere, PATH: '.:' + probe + ':bin::/usr/bin' });
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
      const r = run(d, 'PreToolUse', { cwd: elsewhere, PATH: hang + ':/usr/bin:/bin' });
      const ms = Date.now() - t0;
      assert.strictEqual(r.status, 2, r.stderr);
      assert.ok(/did not finish starting within 2 seconds/.test(r.stderr), r.stderr);
      assert.ok(ms >= 1500 && ms < 20000, 'answered at the deadline: ' + ms + ' ms');
      const p = run(d, 'PostToolUse', { cwd: elsewhere, PATH: hang + ':/usr/bin:/bin' });
      assert.strictEqual(p.status, 0);
      assert.ok(/NOT protecting/.test(p.stdout), p.stdout);
    });

    // The Codex manifest of the same plugin: Codex runs a hook command through a shell with $PLUGIN_ROOT set.
    const codexCmds = manifestCommands('com.openai/hooks.json');
    function runCodex(dir, event, { cwd, PATH, input, env = {} }) {
      return spawnSync('/bin/sh', ['-c', codexCmds[event]], {
        cwd, input: input === undefined ? '{"hook_event_name":"' + event + '"}' : input, encoding: 'utf8', timeout: 60000,
        env: { PATH, HOME: home, PLUGIN_ROOT: dir, ...env },
      });
    }
    const relPaths = ['.:' + realbin, ':' + realbin, 'bin:' + realbin, realbin + ':.'];

    test('Codex: a node planted in the project folder is never run, and the launcher gets the codex arguments', () => {
      const d = plugin('codex-planted');
      const marker = path.join(tmp, 'codex-planted-ran');
      const work = project('codex-work', marker);
      for (const event of Object.keys(codexCmds)) {
        for (const PATH of relPaths) {
          const r = runCodex(d, event, { cwd: work, PATH });
          assert.strictEqual(fs.existsSync(marker), false, event + ' ' + PATH + ': a planted program ran');
          assert.strictEqual(r.status, 0, event + ' ' + PATH + ': ' + r.stderr);
          assert.strictEqual(r.stdout, JSON.stringify({ args: ['hook', 'codex'], stdin: '{"hook_event_name":"' + event + '"}' }), event);
        }
      }
    });

    test('Codex: with no usable Node.js PreToolUse and UserPromptSubmit block (exit 2) and PostToolUse warns', () => {
      const d = plugin('codex-nonode', { patch: noFallback });
      const work = project('codex-nonode-work', path.join(tmp, 'codex-nonode-ran'));
      for (const event of ['PreToolUse', 'UserPromptSubmit']) {
        const r = runCodex(d, event, { cwd: work, PATH: '.:' + emptybin });
        assert.strictEqual(r.status, 2, event + ': ' + r.stderr);
        assert.ok(/^zn: no Node\.js was found.*in Codex \(\/plugins\)\.$/m.test(r.stderr), r.stderr);
      }
      const p = runCodex(d, 'PostToolUse', { cwd: work, PATH: '.:' + emptybin });
      assert.strictEqual(p.status, 0);
      assert.ok(/NOT protecting this session/.test(JSON.parse(p.stdout).systemMessage), p.stdout);
    });

    test('Codex: the start deadline is 26 seconds (its hooks have 30), Claude Code keeps 13', () => {
      const text = fs.readFileSync(NODE_SH, 'utf8');
      assert.ok(/^\[ "\$AGENT" != codex \] \|\| DEADLINE=26$/m.test(text), 'codex deadline');
      const d = plugin('codex-hang', { patch: (t) => t.replace(/DEADLINE=26$/m, 'DEADLINE=2').replace(/^DEADLINE=13$/m, 'DEADLINE=9') });
      const hang = path.join(tmp, 'codex-hangbin');
      fs.mkdirSync(hang);
      fs.writeFileSync(path.join(hang, 'node'), '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
      const r = runCodex(d, 'PreToolUse', { cwd: elsewhere, PATH: hang + ':/usr/bin:/bin' });
      assert.strictEqual(r.status, 2, r.stderr);
      assert.ok(/did not finish starting within 2 seconds/.test(r.stderr), r.stderr);
    });

    // An absolute PATH entry can point into the project too: its bin/, node_modules/.bin, the git work tree around the
    // folder the hook runs in, or the project folder the host names, also through a link. None is trusted for node or sleep.
    test('Claude Code and Codex: a node in an absolute PATH entry inside the project is never run', () => {
      const d = plugin('abs-planted');
      const marker = path.join(tmp, 'abs-planted-ran');
      const work = project('abs-work', marker);
      fs.mkdirSync(path.join(work, '.git'));
      fs.mkdirSync(path.join(work, 'sub'));
      const nm = path.join(work, 'node_modules', '.bin');
      fs.mkdirSync(nm, { recursive: true });
      for (const p of ['node', 'sleep']) fs.writeFileSync(path.join(nm, p), '#!/bin/sh\n: > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
      const linkdir = path.join(tmp, 'abs-linkdir');
      fs.symlinkSync(path.join(work, 'bin'), linkdir);
      const linknode = path.join(tmp, 'abs-linknode');
      fs.mkdirSync(linknode);
      fs.symlinkSync(path.join(work, 'bin', 'node'), path.join(linknode, 'node'));
      const bin = path.join(work, 'bin');
      const cases = [
        [work, bin + ':' + realbin, {}],
        [path.join(work, 'sub'), bin + ':' + realbin, {}],
        [work, nm + ':' + realbin, {}],
        [elsewhere, nm + ':' + realbin, {}],
        [work, linkdir + ':' + realbin, {}],
        [work, linknode + ':' + realbin, {}],
        [elsewhere, bin + ':' + realbin, { CLAUDE_PROJECT_DIR: work }],
        [work, bin + ':/usr/bin:/bin:' + realbin, {}],
      ];
      for (const [cwd, PATH, env] of cases) {
        const r = run(d, 'PreToolUse', { cwd, PATH, env });
        assert.strictEqual(fs.existsSync(marker), false, cwd + ' ' + PATH + ': a planted program ran');
        assert.strictEqual(r.status, 0, cwd + ' ' + PATH + ': ' + r.stderr);
        assert.strictEqual(r.stdout, JSON.stringify({ args: ['hook', 'claude-code'], stdin: '{"hook_event_name":"PreToolUse"}' }), PATH);
        const c = runCodex(d, 'PreToolUse', { cwd, PATH, env });
        assert.strictEqual(fs.existsSync(marker), false, 'codex ' + cwd + ' ' + PATH + ': a planted program ran');
        assert.strictEqual(c.status, 0, 'codex ' + PATH + ': ' + c.stderr);
        assert.strictEqual(c.stdout, JSON.stringify({ args: ['hook', 'codex'], stdin: '{"hook_event_name":"PreToolUse"}' }), PATH);
      }
      // The project's entries are not passed on either.
      const probe = path.join(tmp, 'abs-probe');
      fs.mkdirSync(probe);
      fs.writeFileSync(path.join(probe, 'node'), '#!/bin/sh\nprintf "%s" "$PATH"\n', { mode: 0o755 });
      const p = run(d, 'PreToolUse', { cwd: work, PATH: bin + ':' + probe + ':' + nm + ':/usr/bin' });
      assert.strictEqual(p.stdout, probe + ':/usr/bin');
    });

    test('checking the PATH folders leaves the launcher in the folder the hook runs in', () => {
      const d = plugin('cwd-kept');
      const work = path.join(tmp, 'cwd-work');
      fs.mkdirSync(path.join(work, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(work, '.git'));
      const probe = path.join(tmp, 'cwd-probe');
      fs.mkdirSync(probe);
      fs.writeFileSync(path.join(probe, 'node'), '#!/bin/sh\npwd -P\n', { mode: 0o755 });
      const r = run(d, 'PreToolUse', { cwd: work, PATH: path.join(work, 'bin') + ':' + home + ':' + probe + ':/usr/bin:/bin' });
      assert.strictEqual(r.stdout.trim(), work);
    });

    test('a project folder named "-" (CLAUDE_PROJECT_DIR=-) puts nothing in front of the answer', () => {
      const d = plugin('dash-dir');
      const expected = JSON.stringify({ args: ['hook', 'claude-code'], stdin: '{"hook_event_name":"PreToolUse"}' });
      for (const v of ['-', '--', '-P']) {
        const r = run(d, 'PreToolUse', { cwd: elsewhere, PATH: realbin, env: { CLAUDE_PROJECT_DIR: v, CURSOR_PROJECT_DIR: v, OLDPWD: home } });
        assert.strictEqual(r.status, 0, v + ': ' + r.stderr);
        assert.strictEqual(r.stdout, expected, v);
      }
    });

    test('a session started in the home folder still finds a Node.js there (home is never the project)', () => {
      const d = plugin('home-start');
      const homebin = path.join(home, 'nodebin');
      fs.mkdirSync(homebin);
      fs.symlinkSync(process.execPath, path.join(homebin, 'node'));
      const r = run(d, 'PreToolUse', { cwd: home, PATH: homebin });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(r.stdout, JSON.stringify({ args: ['hook', 'claude-code'], stdin: '{"hook_event_name":"PreToolUse"}' }));
    });

    // Claude Code runs hook commands with bash on Linux and macOS (Git Bash on Windows), not only sh.
    const bash = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'].find((b) => fs.existsSync(b));
    if (!bash) {
      process.stdout.write('ok ' + (++n) + ' - every manifest command under bash -c # SKIP no bash\n');
    } else {
      test('every manifest command under bash -c: the planted node never runs and the launcher gets its arguments', () => {
        const d = plugin('bash-planted');
        const marker = path.join(tmp, 'bash-planted-ran');
        const work = project('bash-work', marker);
        const cases = [];
        for (const event of Object.keys(hooks)) {
          cases.push([commandFor(event, d).command, work, {}, event === 'SessionStart' ? ['check', 'claude-code'] : ['hook', 'claude-code'], event]);
        }
        for (const event of Object.keys(codexCmds)) cases.push([codexCmds[event], work, { PLUGIN_ROOT: d }, ['hook', 'codex'], event]);
        for (const [command, cwd, env, args, event] of cases) {
          for (const PATH of relPaths) {
            const r = spawnSync(bash, ['-c', command], {
              cwd, input: '{"hook_event_name":"' + event + '"}', encoding: 'utf8', timeout: 60000, env: { PATH, HOME: home, ...env },
            });
            assert.strictEqual(fs.existsSync(marker), false, command + ' ' + PATH + ': a planted program ran');
            assert.strictEqual(r.status, 0, command + ' ' + PATH + ': ' + r.stderr);
            assert.strictEqual(r.stdout, JSON.stringify({ args, stdin: '{"hook_event_name":"' + event + '"}' }), command);
          }
        }
      });
    }

    test('a ./ script path never counts: the launcher is treated as missing', () => {
      const d = plugin('relpath');
      for (const agent of ['claude-code', 'codex', 'cursor']) {
        const r = spawnSync('/bin/sh', ['./scripts/zn-node.sh', 'PreToolUse', 'hook', agent], {
          cwd: d, input: '{}', encoding: 'utf8', timeout: 60000, env: { PATH: realbin, HOME: home },
        });
        assert.strictEqual(r.status, 2, agent);
        assert.ok(/zn-launch\.js\) is missing/.test(r.stderr), r.stderr);
      }
    });
  }

  process.stdout.write('1..' + n + '\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
