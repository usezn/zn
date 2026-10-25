#!/usr/bin/env node
'use strict';

/**
 * Tests for the Codex plugin source (plugins/codex): the hooks file against the adapter's own hook entries, the manifest and
 * the marketplace file, and scripts/zn-hook.sh (the one place that decides what happens when zn cannot run) with a stub
 * Node.js and launcher. Codex itself is not needed here; bench/e2e/codex-plugin/ holds the run against the real CLI.
 *
 *   node plugins/tools/test-codex-plugin.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CX = path.join(ROOT, 'plugins', 'codex');
const adapter = require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents', 'codex.js'));
const launcher = require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents', 'launcher.js'));
const posix = process.platform !== 'win32';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-codex-plugin-')));

let n = 0;
function test(name, fn) {
  fn();
  n++;
  process.stdout.write('ok ' + n + ' - ' + name + '\n');
}
function skip(name, why) {
  n++;
  process.stdout.write('ok ' + n + ' - ' + name + ' # SKIP ' + why + '\n');
}
const text = (rel) => fs.readFileSync(path.join(CX, rel), 'utf8');
const json = (rel) => JSON.parse(text(rel));

try {
  test('hooks.json carries the same events, matchers, timeout and status text as the entries `zn hooks install codex` writes', () => {
    const mine = json('hooks/hooks.json').hooks;
    const theirs = adapter.hookGroups((event) => ({ event }));
    assert.deepStrictEqual(Object.keys(mine).sort(), Object.keys(theirs).sort());
    for (const [event, group] of Object.entries(theirs)) {
      assert.strictEqual(mine[event].length, 1, event);
      assert.strictEqual(mine[event][0].matcher, group.matcher, event + ' matcher');
      assert.strictEqual(mine[event][0].hooks.length, 1);
      const h = mine[event][0].hooks[0];
      assert.strictEqual(h.type, 'command', event);
      assert.strictEqual(h.command, 'sh "$PLUGIN_ROOT/scripts/zn-hook.sh" ' + event, event + ' command');
      assert.strictEqual(h.timeout, adapter.HOOK_TIMEOUT_S, event + ' timeout');
      assert.strictEqual(h.statusMessage, adapter.HOOK_STATUS);
      // A background hook cannot block; a disabled one does nothing.
      assert.ok(!('async' in h) && !('enabled' in h) && !('onFailure' in h), event + ': a key that would turn the hook off or let it run in the background');
    }
  });

  test('hooks.json is at the default path Codex looks in, so the manifest names no hooks', () => {
    const m = json('.codex-plugin/plugin.json');
    assert.ok(fs.existsSync(path.join(CX, 'hooks', 'hooks.json')));
    // "If a manifest defines hooks, Codex uses those manifest entries instead of the default hooks/hooks.json."
    for (const k of ['hooks', 'mcpServers', 'apps', 'skills']) assert.ok(!(k in m), k);
  });

  test('the manifest and the marketplace name one plugin, with its icon and the same pin as the Claude Code plugin', () => {
    const m = json('.codex-plugin/plugin.json');
    assert.strictEqual(m.name, 'zn-gate');
    assert.ok(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(m.version));
    assert.strictEqual(m.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'zn-gate', '.claude-plugin', 'plugin.json'), 'utf8')).version);
    for (const k of ['composerIcon', 'logo']) {
      assert.strictEqual(m.interface[k], './assets/icon.png', k);
      assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'zn-gate', 'icon.png')), 'icon.png, which the build copies to assets/icon.png');
    }
    assert.ok(/\/hooks/.test(m.interface.longDescription), 'the description says the hooks need the /hooks review');
    const mk = json('marketplace.json');
    assert.strictEqual(mk.plugins.length, 1);
    assert.strictEqual(mk.plugins[0].name, 'zn-gate');
    assert.deepStrictEqual(mk.plugins[0].source, { source: 'local', path: './plugins/zn-gate' });
    // The build writes the plugin to the folder the marketplace names.
    assert.strictEqual(require('./build-plugin-repo').CODEX_DIR, 'plugins/zn-gate');
  });

  test('the launcher accepts the codex agent and the hook script runs it in that mode', () => {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'zn-gate', 'scripts', 'zn-launch.js'), 'utf8');
    const m = /const SUPPORTED_AGENTS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m && /'codex'/.test(m[1]));
    assert.strictEqual(require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents')).getAdapter('codex').id, 'codex');
    assert.ok(/"\$LAUNCH" hook codex/.test(text('scripts/zn-hook.sh')));
  });

  test('zn-hook.sh refuses on the events the launcher blocks for Codex, and its deadline is below the hook timeout', () => {
    const script = text('scripts/zn-hook.sh');
    const deadline = Number(/^DEADLINE=(\d+)$/m.exec(script)[1]);
    assert.strictEqual(deadline, launcher.launcherDeadlineS(adapter.HOOK_TIMEOUT_S), 'DEADLINE matches the launcher deadline of zn hooks install codex');
    assert.ok(deadline < adapter.HOOK_TIMEOUT_S);
    // The case labels of refuse(): exit-2 events, then the deny-JSON event.
    const labels = (re) => (re.exec(script)[1].match(/[A-Za-z]+/g) || []).filter((w) => w !== '');
    const exit2 = labels(/refuse\(\) \{\n\s+case "\$EVENT" in\n\s+([^)]*)\)/);
    const json = labels(/\n\s+(PermissionRequest)\)\n/);
    assert.deepStrictEqual([...launcher.blockExit('codex')].sort(), exit2.sort());
    assert.deepStrictEqual([...launcher.blockJson('codex')].sort(), json.sort());
  });

  if (!posix) {
    skip('zn-hook.sh behaviour', 'POSIX shell script');
  } else {
    const HOOK = path.join(CX, 'scripts', 'zn-hook.sh');
    // A plugin folder with the script and a stub launcher; a stub "node" that answers the version probe and runs the stub.
    function fixture(name, { launcher: launch, probe = 0, withNode = true, withLauncher = true, deadline }) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'bin'));
      let script = fs.readFileSync(HOOK, 'utf8');
      if (deadline) script = script.replace(/^DEADLINE=\d+$/m, 'DEADLINE=' + deadline);
      fs.writeFileSync(path.join(dir, 'scripts', 'zn-hook.sh'), script);
      if (withLauncher) fs.writeFileSync(path.join(dir, 'scripts', 'zn-launch.js'), launch || '');
      if (withNode) {
        // "-e" is the version probe; anything else is a run of the launcher: keep stdin, print what the stub says, exit as told.
        // ZN_STUB_HANG=probe or launch makes that step hang.
        fs.writeFileSync(path.join(dir, 'bin', 'node'), '#!/bin/sh\nif [ "$1" = "-e" ]; then [ "$ZN_STUB_HANG" = probe ] && exec sleep 300; exit ' + probe + '; fi\n[ "$ZN_STUB_HANG" = launch ] && exec sleep 300\ncat > "$ZN_STUB_STDIN"\nprintf "%s" "$ZN_STUB_OUT"\nexit "${ZN_STUB_RC:-0}"\n', { mode: 0o755 });
      }
      return dir;
    }
    function run(dir, event, env) {
      // The script's parent is a shell, not a program of ours; HOME has no node folders.
      const stdin = path.join(dir, 'stdin.txt');
      const r = spawnSync('/bin/sh', ['-c', 'sh "$0" "$1"; exit $?', path.join(dir, 'scripts', 'zn-hook.sh'), event], {
        input: '{"hook_event_name":"' + event + '"}', encoding: 'utf8',
        env: { PATH: path.join(dir, 'bin') + ':/usr/bin:/bin', HOME: path.join(dir, 'home'), ZN_STUB_STDIN: stdin, ...env },
        timeout: 60000,
      });
      r.stdin = fs.existsSync(stdin) ? fs.readFileSync(stdin, 'utf8') : null;
      return r;
    }
    const hasSystemNode = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].some((f) => fs.existsSync(f));
    const denyJson = (out) => JSON.parse(out).hookSpecificOutput;

    test('zn-hook.sh never starts a node from a relative or empty PATH entry, and refuses a start by a relative path', () => {
      const d = fixture('relpath', { launcher: '// stub' });
      const work = path.join(tmp, 'relpath-work');
      const marker = path.join(work, 'planted-ran');
      fs.mkdirSync(path.join(work, 'bin'), { recursive: true });
      for (const dir of [work, path.join(work, 'bin')]) {
        for (const n of ['node', 'sleep', 'ps']) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n: > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
      }
      const real = path.join(d, 'bin');
      for (const PATH of ['.:' + real + ':/usr/bin:/bin', real + ':.:/usr/bin:/bin', real + ':/usr/bin:/bin:.', 'bin:' + real + ':/usr/bin:/bin', ':' + real + ':/usr/bin:/bin']) {
        const r = spawnSync('/bin/sh', ['-c', 'cd "$1" && sh "$0" PreToolUse', path.join(d, 'scripts', 'zn-hook.sh'), work], {
          input: '{"hook_event_name":"PreToolUse"}', encoding: 'utf8', timeout: 30000,
          env: { PATH, HOME: path.join(d, 'home'), ZN_STUB_STDIN: path.join(d, 'stdin.txt'), ZN_STUB_OUT: '{}' },
        });
        assert.strictEqual(fs.existsSync(marker), false, PATH + ': a planted program ran');
        assert.strictEqual(r.status, 0, PATH + ': ' + r.stderr);
      }
      const rel = spawnSync('/bin/sh', ['-c', 'cd "$1" && sh scripts/zn-hook.sh PreToolUse', '_', d], { input: '{}', encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin' } });
      assert.strictEqual(rel.status, 2, rel.stderr);
      assert.ok(/launcher \(scripts\/zn-launch\.js\) is missing/.test(rel.stderr), rel.stderr);
    });

    test('zn-hook.sh passes the event JSON to the launcher and its answer and exit code 0 or 2 through', () => {
      const d = fixture('pass', { launcher: '// stub' });
      const a = run(d, 'PreToolUse', { ZN_STUB_OUT: '{"x":1}', ZN_STUB_RC: '0' });
      assert.strictEqual(a.status, 0);
      assert.strictEqual(a.stdout, '{"x":1}');
      assert.strictEqual(a.stdin, '{"hook_event_name":"PreToolUse"}');
      const b = run(d, 'PreToolUse', { ZN_STUB_OUT: '', ZN_STUB_RC: '2' });
      assert.strictEqual(b.status, 2);
    });

    test('zn-hook.sh blocks PreToolUse and UserPromptSubmit with exit 2 when the launcher fails', () => {
      const d = fixture('fail', { launcher: '// stub' });
      for (const event of ['PreToolUse', 'UserPromptSubmit']) {
        const r = run(d, event, { ZN_STUB_RC: '1' });
        assert.strictEqual(r.status, 2, event);
        assert.ok(/^zn: the hook ended with exit code 1/.test(r.stderr), r.stderr);
      }
      assert.strictEqual(run(d, 'PreToolUse', { ZN_STUB_RC: '139' }).status, 2, 'a crash');
      assert.strictEqual(run(d, 'PreToolUse', { ZN_STUB_RC: '127' }).status, 2);
    });

    test('zn-hook.sh denies a PermissionRequest with the documented decision when the launcher fails', () => {
      const d = fixture('perm', { launcher: '// stub' });
      const r = run(d, 'PermissionRequest', { ZN_STUB_RC: '1' });
      assert.strictEqual(r.status, 0);
      const o = denyJson(r.stdout);
      assert.strictEqual(o.hookEventName, 'PermissionRequest');
      assert.strictEqual(o.decision.behavior, 'deny');
      assert.ok(/ended with exit code 1/.test(o.decision.message));
    });

    test('zn-hook.sh only warns (a systemMessage the user sees) on the events that cannot block', () => {
      const d = fixture('warn', { launcher: '// stub' });
      for (const event of ['PostToolUse', 'SessionStart', 'SubagentStart', 'Stop']) {
        const r = run(d, event, { ZN_STUB_RC: '1' });
        assert.strictEqual(r.status, 0, event);
        assert.ok(/NOT protecting this session/.test(JSON.parse(r.stdout).systemMessage), event);
      }
    });

    test('zn-hook.sh blocks when scripts/zn-launch.js is missing', () => {
      const d = fixture('nolaunch', { withLauncher: false });
      const r = run(d, 'PreToolUse', {});
      assert.strictEqual(r.status, 2);
      assert.ok(/launcher \(scripts\/zn-launch\.js\) is missing/.test(r.stderr));
    });

    test('zn-hook.sh does not use a Node.js that is too old', () => {
      const d = fixture('old', { launcher: '// stub', probe: 1 });
      if (hasSystemNode) return; // a system Node.js outside the PATH would be found (and is a fine answer)
      const r = run(d, 'PreToolUse', {});
      assert.strictEqual(r.status, 2);
      assert.ok(/no Node\.js 20\.19 or later was found/.test(r.stderr));
    });

    test('zn-hook.sh blocks with no Node.js at all, and warns only on PostToolUse', () => {
      const d = fixture('nonode', { launcher: '// stub', withNode: false });
      if (hasSystemNode) return;
      const r = run(d, 'PreToolUse', {});
      assert.strictEqual(r.status, 2);
      assert.ok(/no Node\.js 20\.19 or later was found/.test(r.stderr));
      assert.strictEqual(run(d, 'PostToolUse', {}).status, 0);
      assert.strictEqual(denyJson(run(d, 'PermissionRequest', {}).stdout).decision.behavior, 'deny');
    });

    for (const hang of ['probe', 'launch']) {
      test('zn-hook.sh answers at its deadline when Node.js hangs in the ' + hang + ', by event', () => {
        // The script's own deadline is checked above; here a 2 s copy, so the test does not wait 25 s.
        const d = fixture('hang-' + hang, { launcher: '// stub', deadline: 2 });
        const t0 = Date.now();
        const r = run(d, 'PreToolUse', { ZN_STUB_HANG: hang });
        const ms = Date.now() - t0;
        assert.strictEqual(r.status, 2, r.stderr);
        assert.ok(/^zn: the hook did not finish starting within 2 seconds/.test(r.stderr), r.stderr);
        assert.ok(ms >= 1500 && ms < 15000, 'answered at the deadline: ' + ms + ' ms');
        assert.strictEqual(run(d, 'UserPromptSubmit', { ZN_STUB_HANG: hang }).status, 2);
        const p = run(d, 'PermissionRequest', { ZN_STUB_HANG: hang });
        assert.strictEqual(p.status, 0);
        assert.strictEqual(denyJson(p.stdout).decision.behavior, 'deny');
        const post = run(d, 'PostToolUse', { ZN_STUB_HANG: hang });
        assert.strictEqual(post.status, 0);
        assert.ok(/NOT protecting this session/.test(JSON.parse(post.stdout).systemMessage));
      });
    }

    test('zn-hook.sh with a deadline still lets a fast launcher finish at once (the deadline is only a cap)', () => {
      const d = fixture('fast', { launcher: '// stub', deadline: 2 });
      const t0 = Date.now();
      const r = run(d, 'PreToolUse', { ZN_STUB_OUT: '{"ok":true}', ZN_STUB_RC: '0' });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, '{"ok":true}');
      assert.ok(Date.now() - t0 < 1900, 'the watchdog does not delay a finished hook');
    });

    test('zn-hook.sh needs no external program to refuse (empty PATH)', () => {
      const d = fixture('nopath', { launcher: '// stub', withNode: false });
      if (['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].some((f) => fs.existsSync(f))) return; // found in a usual folder
      const r = spawnSync('/bin/sh', ['-c', '/bin/sh "$0" "$1"; exit $?', path.join(d, 'scripts', 'zn-hook.sh'), 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: '/nonexistent', HOME: '/nonexistent' } });
      assert.strictEqual(r.status, 2);
    });
  }

  process.stdout.write('1..' + n + '\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
