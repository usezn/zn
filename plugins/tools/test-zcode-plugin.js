#!/usr/bin/env node
'use strict';

/**
 * Tests for the ZCode plugin source (plugins/zcode): the hooks file against the adapter's own hook entries, the manifest,
 * and scripts/zn-hook.sh (the one place that decides what happens when zn cannot run) with a stub Node.js and launcher.
 * The ZCode app itself is not needed here; bench/e2e/zcode-plugin/ holds the run against the real app.
 *
 *   node plugins/tools/test-zcode-plugin.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ZC = path.join(ROOT, 'plugins', 'zcode');
const adapter = require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents', 'zcode.js'));
const posix = process.platform !== 'win32';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-zcode-plugin-')));

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
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ZC, rel), 'utf8'));

try {
  test('hooks.json carries the same events, matchers, timeout and status text as the entries `zn hooks install zcode` writes', () => {
    const mine = json('hooks/hooks.json').hooks;
    const theirs = adapter.hookGroups((event) => ({ event }));
    assert.deepStrictEqual(Object.keys(mine).sort(), Object.keys(theirs).sort());
    for (const [event, group] of Object.entries(theirs)) {
      assert.strictEqual(mine[event].length, 1, event);
      assert.strictEqual(mine[event][0].matcher, group.matcher, event + ' matcher');
      assert.strictEqual(mine[event][0].hooks.length, 1);
      const h = mine[event][0].hooks[0];
      assert.strictEqual(h.type, 'process', event + ': no shell between ZCode and sh');
      // By its full path: ZCode looks a bare name up on its PATH, where a relative or empty entry finds the project's files.
      assert.strictEqual(h.command, '/bin/sh');
      assert.deepStrictEqual(h.args, ['${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh', event]);
      assert.strictEqual(h.timeoutMs, adapter.HOOK_TIMEOUT_MS, event + ' timeout');
      assert.strictEqual(h.statusMessage, adapter.HOOK_STATUS);
      assert.ok(!('onFailure' in h) && !('async' in h) && !('enabled' in h), event + ': a key ZCode does not document or one that turns the hook off');
    }
  });

  test('hooks.json uses only events and tool names ZCode documents', () => {
    const text = fs.readFileSync(path.join(ZC, 'hooks', 'hooks.json'), 'utf8');
    for (const word of ['onFailure', 'UserPromptExpansion', 'PowerShell', 'MultiEdit', 'NotebookEdit', 'claude-code', 'SessionStart', 'Stop']) {
      assert.ok(!text.includes(word), word + ' must not appear');
    }
    const post = json('hooks/hooks.json').hooks.PostToolUse[0].matcher;
    assert.ok(new RegExp(post).test('mcp__secrets__x') && new RegExp(post).test('Bash') && !new RegExp(post).test('Write'));
  });

  test('the manifest and the marketplace name one plugin, with nothing to configure', () => {
    const m = json('.zcode-plugin/plugin.json');
    assert.strictEqual(m.name, 'zn-gate');
    assert.ok(/^\d+\.\d+\.\d+$/.test(m.version));
    for (const k of ['hooks', 'mcpServers', 'userConfig', 'commands', 'agents']) assert.ok(!(k in m), k);
    assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'zn-gate', m.icon.replace(/^\.\//, ''))), 'icon');
    const mk = json('marketplace.json');
    assert.strictEqual(mk.plugins.length, 1);
    assert.strictEqual(mk.plugins[0].name, 'zn-gate');
    assert.strictEqual(mk.plugins[0].source, './zn-gate');
    assert.strictEqual(m.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'zn-gate', '.claude-plugin', 'plugin.json'), 'utf8')).version, 'same pin as the Claude Code plugin');
  });

  test('the launcher accepts the zcode agent and the adapter it names exists', () => {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'zn-gate', 'scripts', 'zn-launch.js'), 'utf8');
    const m = /const SUPPORTED_AGENTS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m && /'zcode'/.test(m[1]));
    assert.strictEqual(require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents')).getAdapter('zcode').id, 'zcode');
    assert.ok(fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.sh'), 'utf8').includes('zn-launch.js" hook zcode') || /hook zcode/.test(fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.sh'), 'utf8')));
  });

  if (!posix) {
    skip('zn-hook.sh behaviour', 'POSIX shell script');
  } else {
    const HOOK = path.join(ZC, 'scripts', 'zn-hook.sh');
    // A plugin folder with the script and a stub launcher; a stub "node" that answers the version probe and runs the stub.
    function fixture(name, { launcher, probe = 0, withNode = true, withLauncher = true }) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.copyFileSync(HOOK, path.join(dir, 'scripts', 'zn-hook.sh'));
      if (withLauncher) fs.writeFileSync(path.join(dir, 'scripts', 'zn-launch.js'), launcher || '');
      if (withNode) {
        // "-e" is the version probe; anything else is a run of the launcher: print what the stub says and exit as told.
        fs.writeFileSync(path.join(dir, 'bin', 'node'), '#!/bin/sh\nif [ "$1" = "-e" ]; then exit ' + probe + '; fi\ncat >/dev/null\nprintf "%s" "$ZN_STUB_OUT"\nexit "${ZN_STUB_RC:-0}"\n', { mode: 0o755 });
      }
      return dir;
    }
    // The hook script runs under a small parent shell script (a fixed file, no command string built at run time), so its
    // parent program is a shell, not a Node.js program.
    function parentShell(inner) {
      const f = path.join(tmp, 'parent-' + inner.replace(/\W/g, '_') + '.sh');
      if (!fs.existsSync(f)) fs.writeFileSync(f, '#!/bin/sh\n' + inner + ' "$1" "$2"\nexit $?\n', { mode: 0o755 });
      return f;
    }
    function run(dir, event, env) {
      // The script's parent is a shell, not a Node.js program: the "parent program" fallback finds nothing usable.
      return spawnSync('/bin/sh', [parentShell('sh'), path.join(dir, 'scripts', 'zn-hook.sh'), event], {
        input: '{"hook_event_name":"' + event + '"}', encoding: 'utf8',
        env: { PATH: path.join(dir, 'bin') + ':/usr/bin:/bin', HOME: path.join(dir, 'home'), ...env },
      });
    }

    test('zn-hook.sh passes the launcher answer and exit code 0 or 2 through', () => {
      const d = fixture('pass', { launcher: '// stub' });
      const t0 = Date.now();
      const a = run(d, 'PreToolUse', { ZN_STUB_OUT: '{"x":1}', ZN_STUB_RC: '0' });
      // The deadline watchdog must not outlive the hook or keep its output open (it would last the whole deadline).
      assert.ok(Date.now() - t0 < 15000, 'the hook returned at once, not after the deadline');
      assert.strictEqual(a.status, 0);
      assert.strictEqual(a.stdout, '{"x":1}');
      const b = run(d, 'PreToolUse', { ZN_STUB_OUT: '', ZN_STUB_RC: '2' });
      assert.strictEqual(b.status, 2);
    });

    test('zn-hook.sh blocks (exit 2) a blocking event when the launcher fails, and only warns on PostToolUse', () => {
      const d = fixture('fail', { launcher: '// stub' });
      for (const event of ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit']) {
        const r = run(d, event, { ZN_STUB_RC: '1' });
        assert.strictEqual(r.status, 2, event);
        assert.ok(/^zn: the hook ended with exit code 1/.test(r.stderr), r.stderr);
      }
      const p = run(d, 'PostToolUse', { ZN_STUB_RC: '1' });
      assert.strictEqual(p.status, 0);
      assert.ok(/NOT protecting this session/.test(p.stderr));
      const crash = run(d, 'PreToolUse', { ZN_STUB_RC: '139' });
      assert.strictEqual(crash.status, 2);
    });

    test('zn-hook.sh blocks when scripts/zn-launch.js is missing', () => {
      const d = fixture('nolaunch', { withLauncher: false });
      const r = run(d, 'PreToolUse', {});
      assert.strictEqual(r.status, 2);
      assert.ok(/launcher \(scripts\/zn-launch\.js\) is missing/.test(r.stderr));
    });

    test('zn-hook.sh does not use a Node.js that is too old', () => {
      const d = fixture('old', { launcher: '// stub', probe: 1 });
      const hasSystemNode = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].some((f) => fs.existsSync(f));
      if (hasSystemNode) return; // a system Node.js outside the PATH would be found (and is a fine answer)
      const r = run(d, 'PreToolUse', {});
      assert.strictEqual(r.status, 2);
      assert.ok(/no Node\.js 20\.19 or later was found/.test(r.stderr));
    });

    test('zn-hook.sh blocks with no Node.js at all, and warns only on PostToolUse', () => {
      const hasSystemNode = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].some((f) => fs.existsSync(f));
      const d = fixture('nonode', { launcher: '// stub', withNode: false });
      if (hasSystemNode) return;
      const r = run(d, 'PreToolUse', {});
      assert.strictEqual(r.status, 2);
      assert.ok(/no Node\.js 20\.19 or later was found/.test(r.stderr));
      assert.strictEqual(run(d, 'PostToolUse', {}).status, 0);
    });

    test('zn-hook.sh needs no external program to refuse (empty PATH)', () => {
      const d = fixture('nopath', { launcher: '// stub', withNode: false });
      if (['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].some((f) => fs.existsSync(f))) return; // found in a usual folder
      const r = spawnSync('/bin/sh', [parentShell('/bin/sh'), path.join(d, 'scripts', 'zn-hook.sh'), 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: '/nonexistent', HOME: '/nonexistent' } });
      assert.strictEqual(r.status, 2);
    });
  }

  if (posix) {
    const HOOK = path.join(ZC, 'scripts', 'zn-hook.sh');
    // Small fixed parent scripts (written once, no command string built at run time); the values arrive as arguments.
    const fixedScript = (name, body) => {
      const f = path.join(tmp, 'fixed-' + name + '.sh');
      if (!fs.existsSync(f)) fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
      return f;
    };
    const timed = (d, event, env) => {
      const t0 = Date.now();
      const r = spawnSync('/bin/sh', [fixedScript('run-sh', 'sh "$1" "$2"; exit $?'), path.join(d, 'scripts', 'zn-hook.sh'), event], {
        input: '{"hook_event_name":"' + event + '"}', encoding: 'utf8', timeout: 60000,
        env: { PATH: path.join(d, 'bin') + ':/usr/bin:/bin', HOME: path.join(d, 'home'), ...env },
      });
      return { r, ms: Date.now() - t0 };
    };
    // Same stub folder as above, rebuilt here because the helpers above live in the previous block.
    const fixture2 = (name, deadline) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'scripts', 'zn-launch.js'), '// stub');
      const text = fs.readFileSync(HOOK, 'utf8');
      assert.ok(/^DEADLINE=28$/m.test(text));
      // Test copy only: the shipped script has no setting for the deadline.
      fs.writeFileSync(path.join(dir, 'scripts', 'zn-hook.sh'), text.replace(/^DEADLINE=28$/m, 'DEADLINE=' + deadline));
      fs.writeFileSync(path.join(dir, 'bin', 'node'), '#!/bin/sh\nif [ "$1" = "-e" ]; then [ "$ZN_STUB_HANG" = probe ] && exec sleep 300; exit 0; fi\n[ "$ZN_STUB_HANG" = launch ] && exec sleep 300\ncat >/dev/null\nprintf "%s" "$ZN_STUB_OUT"\nexit "${ZN_STUB_RC:-0}"\n', { mode: 0o755 });
      return dir;
    };

    test('zn-hook.sh never starts a node from a relative or empty PATH entry (start, middle, end), and passes only absolute entries on', () => {
      const d = fixture2('relpath', 28);
      const work = path.join(tmp, 'relpath-work');
      const marker = path.join(work, 'planted-ran');
      fs.mkdirSync(path.join(work, 'bin'), { recursive: true });
      for (const dir of [work, path.join(work, 'bin')]) {
        for (const n of ['node', 'zn', 'sleep', 'ps']) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n: > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
      }
      const real = path.join(d, 'bin');
      for (const PATH of ['.:' + real + ':/usr/bin:/bin', real + ':.:/usr/bin:/bin', real + ':/usr/bin:/bin:.', 'bin:' + real + ':/usr/bin:/bin', ':' + real + ':/usr/bin:/bin']) {
        const r = spawnSync('/bin/sh', [fixedScript('cd-sh', 'cd "$2" && sh "$1" PreToolUse'), path.join(d, 'scripts', 'zn-hook.sh'), work], {
          input: '{"hook_event_name":"PreToolUse"}', encoding: 'utf8', timeout: 30000,
          env: { PATH, HOME: path.join(d, 'home'), ZN_STUB_OUT: '{"decision":"allow"}' },
        });
        assert.strictEqual(fs.existsSync(marker), false, PATH + ': a planted program ran');
        assert.strictEqual(r.status, 0, PATH + ': ' + r.stderr);
      }
      // With only relative or empty entries the hook still runs (it falls back to the system folders), and nothing planted runs.
      for (const PATH of ['.:bin:', '', ':']) {
        const r = spawnSync('/bin/sh', [fixedScript('cd-bin-sh', 'cd "$2" && /bin/sh "$1" PreToolUse'), path.join(d, 'scripts', 'zn-hook.sh'), work], {
          input: '{}', encoding: 'utf8', timeout: 30000, env: { PATH, HOME: '/nonexistent' },
        });
        assert.ok(r.status === 0 || r.status === 2, JSON.stringify(PATH) + ': the hook did not run (' + r.status + '): ' + r.stderr);
        assert.ok(r.status === 0 || /^zn: /.test(r.stderr), JSON.stringify(PATH) + ': ' + r.stderr);
        assert.strictEqual(fs.existsSync(marker), false, JSON.stringify(PATH) + ': a planted program ran');
      }
      // Started by a relative path, the script does not trust the folder it was started from.
      const rel = spawnSync('/bin/sh', [fixedScript('cd-rel', 'cd "$1" && sh scripts/zn-hook.sh PreToolUse'), d], { input: '{}', encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin' } });
      assert.strictEqual(rel.status, 2, rel.stderr);
      assert.ok(/launcher \(scripts\/zn-launch\.js\) is missing/.test(rel.stderr), rel.stderr);
    });

    test('zn-hook.sh has a start deadline under ZCode\'s 30 second hook timeout', () => {
      const m = /^DEADLINE=(\d+)$/m.exec(fs.readFileSync(HOOK, 'utf8'));
      assert.ok(m, 'DEADLINE is set');
      assert.strictEqual(Number(m[1]), adapter.LAUNCHER_DEADLINE_S, 'DEADLINE matches the launcher deadline of zn hooks install zcode');
      assert.ok(Number(m[1]) * 1000 < adapter.HOOK_TIMEOUT_MS);
    });

    for (const hang of ['probe', 'launch']) {
      test('zn-hook.sh blocks at the deadline when Node.js hangs in the ' + hang + ' (and only warns on PostToolUse)', () => {
        const d = fixture2('hang-' + hang, 2);
        const { r, ms } = timed(d, 'PreToolUse', { ZN_STUB_HANG: hang });
        assert.strictEqual(r.status, 2, r.stderr);
        assert.ok(/^zn: the hook did not finish starting within 2 seconds/.test(r.stderr), r.stderr);
        assert.ok(ms >= 1500 && ms < 15000, 'answered at the deadline, not before and not long after: ' + ms + ' ms');
        for (const event of ['PermissionRequest', 'UserPromptSubmit']) {
          assert.strictEqual(timed(d, event, { ZN_STUB_HANG: hang }).r.status, 2, event);
        }
        const p = timed(d, 'PostToolUse', { ZN_STUB_HANG: hang });
        assert.strictEqual(p.r.status, 0);
        assert.ok(/NOT protecting this session/.test(p.r.stderr), p.r.stderr);
      });
    }

    test('zn-hook.sh with a deadline still lets a fast launcher finish (the deadline is only a cap)', () => {
      const d = fixture2('fast-deadline', 2);
      const { r, ms } = timed(d, 'PreToolUse', { ZN_STUB_OUT: '{"ok":true}', ZN_STUB_RC: '0' });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, '{"ok":true}');
      assert.ok(ms < 1900, 'the watchdog does not delay a finished hook: ' + ms + ' ms');
    });
  }

  process.stdout.write('1..' + n + '\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
