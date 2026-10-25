#!/usr/bin/env node
'use strict';

/**
 * Tests for the Antigravity CLI plugin source (plugins/antigravity): the hooks file against the adapter's own hook entry,
 * the manifest, and scripts/zn-hook.sh (the one place that decides what happens when zn cannot run) with a stub Node.js
 * and launcher. The Antigravity CLI itself is not needed here.
 *
 *   node plugins/tools/test-antigravity-plugin.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const AG = path.join(ROOT, 'plugins', 'antigravity');
const adapter = require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents', 'antigravity.js'));
const posix = process.platform !== 'win32';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-agy-plugin-')));

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
const json = (rel) => JSON.parse(fs.readFileSync(path.join(AG, rel), 'utf8'));

try {
  test('hooks.json is the entry `zn hooks install antigravity` writes, with the plugin command', () => {
    assert.deepStrictEqual(json('hooks.json'), { 'zn-gate': adapter.hookEntry(adapter.PLUGIN_COMMAND) });
    const h = json('hooks.json')['zn-gate'];
    assert.strictEqual(h.PreToolUse.length, 1);
    assert.strictEqual(h.PreToolUse[0].matcher, adapter.MATCHER);
    assert.strictEqual(h.PreToolUse[0].hooks[0].timeout, adapter.HOOK_TIMEOUT_S);
    assert.strictEqual(h.PreToolUse[0].hooks[0].command, 'sh scripts/zn-hook.sh');
    assert.deepStrictEqual(Object.keys(h).sort(), ['PreToolUse', 'enabled']);
  });

  test('the manifest has only the keys Antigravity accepts, and a name it accepts', () => {
    const m = json('plugin.json');
    for (const k of Object.keys(m)) assert.ok(['name', 'description', '$schema'].includes(k), k);
    assert.strictEqual(m.name, 'zn-gate');
    assert.ok(/^[a-zA-Z0-9-_]+$/.test(m.name));
    assert.ok(typeof m.description === 'string' && m.description.length > 20);
    assert.ok(!('version' in m), 'no version key: Antigravity rejects it');
  });

  test('the launcher accepts the antigravity agent and the adapter it names exists', () => {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'zn-gate', 'scripts', 'zn-launch.js'), 'utf8');
    const m = /const SUPPORTED_AGENTS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m && /'antigravity'/.test(m[1]));
    assert.strictEqual(require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'agents')).getAdapter('antigravity').id, 'antigravity');
    const script = fs.readFileSync(path.join(AG, 'scripts', 'zn-hook.sh'), 'utf8');
    assert.ok(/hook antigravity/.test(script));
    assert.ok(/^#!\/bin\/sh\n/.test(script));
  });

  test('the files of the plugin name no other agent and no internal reference', () => {
    for (const f of ['plugin.json', 'hooks.json', 'scripts/zn-hook.sh', 'README.md']) {
      const text = fs.readFileSync(path.join(AG, ...f.split('/')), 'utf8');
      for (const word of ['claude-code', 'ZCODE', 'ops-rules', 'dev1', 'dev2']) assert.ok(!text.includes(word), f + ' names ' + word);
    }
  });

  if (!posix) {
    skip('zn-hook.sh behaviour', 'POSIX shell script');
  } else {
    const HOOK = path.join(AG, 'scripts', 'zn-hook.sh');
    // A plugin folder with the script and a stub launcher; a stub "node" that answers the version probe and runs the stub.
    function fixture(name, { launcher, probe = 0, withNode = true, withLauncher = true, deadline } = {}) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'bin'));
      let text = fs.readFileSync(HOOK, 'utf8');
      // Test copy only: the shipped script has no setting for the deadline.
      if (deadline) text = text.replace(/^DEADLINE=\d+$/m, 'DEADLINE=' + deadline);
      fs.writeFileSync(path.join(dir, 'scripts', 'zn-hook.sh'), text);
      if (withLauncher) fs.writeFileSync(path.join(dir, 'scripts', 'zn-launch.js'), launcher || '');
      if (withNode) {
        // "-e" is the version probe; anything else is a run of the launcher: print what the stub says and exit as told.
        fs.writeFileSync(path.join(dir, 'bin', 'node'),
          '#!/bin/sh\nif [ "$1" = "-e" ]; then [ "$ZN_STUB_HANG" = probe ] && exec sleep 300; exit ' + probe + '; fi\n' +
          '[ "$ZN_STUB_HANG" = launch ] && exec sleep 300\ncat >/dev/null\nprintf "%s" "$ZN_STUB_OUT"\nexit "${ZN_STUB_RC:-0}"\n', { mode: 0o755 });
      }
      return dir;
    }
    // Antigravity runs the command `sh scripts/zn-hook.sh` from the plugin folder.
    function run(dir, env, opts = {}) {
      const t0 = Date.now();
      const r = spawnSync('/bin/sh', ['-c', 'sh scripts/zn-hook.sh'], {
        cwd: dir, input: '{"toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}', encoding: 'utf8', timeout: 60000,
        env: { PATH: path.join(dir, 'bin') + ':/usr/bin:/bin', HOME: path.join(dir, 'home'), ...env },
        ...opts,
      });
      return { r, ms: Date.now() - t0 };
    }
    const hasSystemNode = () => ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'].some((f) => fs.existsSync(f));
    const denied = (r, re) => {
      assert.strictEqual(r.status, 0, 'a refusal is a decision on stdout, exit 0: ' + r.stderr);
      const answer = JSON.parse(r.stdout);
      assert.deepStrictEqual(Object.keys(answer).sort(), ['decision', 'reason']);
      assert.strictEqual(answer.decision, 'deny');
      assert.match(answer.reason, re);
      return answer;
    };

    test('zn-hook.sh passes the launcher answer through and returns at once', () => {
      const d = fixture('pass', { launcher: '// stub' });
      const { r, ms } = run(d, { ZN_STUB_OUT: '{"decision":"allow"}', ZN_STUB_RC: '0' });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, '{"decision":"allow"}');
      // The deadline watchdog must not outlive the hook or keep its output open (it would last the whole deadline).
      assert.ok(ms < 8000, 'returned at once, not after the deadline: ' + ms + ' ms');
    });

    test('zn-hook.sh answers a deny with the reason when the launcher fails, whatever its exit code', () => {
      const d = fixture('fail', { launcher: '// stub' });
      for (const rc of ['1', '2', '3', '137', '139']) {
        denied(run(d, { ZN_STUB_RC: rc }).r, /^zn: the hook ended with exit code /);
      }
      const a = denied(run(d, { ZN_STUB_RC: '1' }).r, /ended with exit code 1/);
      assert.ok(/agy plugin disable zn-gate/.test(a.reason), 'the reason says how to turn the plugin off');
    });

    test('zn-hook.sh answers a deny when scripts/zn-launch.js is missing', () => {
      const d = fixture('nolaunch', { withLauncher: false });
      denied(run(d, {}).r, /launcher \(scripts\/zn-launch\.js\) is missing/);
    });

    test('zn-hook.sh works from the plugin folder only through its own location, not the working folder', () => {
      const d = fixture('where', { launcher: '// stub' });
      const r = spawnSync('/bin/sh', ['-c', 'sh "$0"', path.join(d, 'scripts', 'zn-hook.sh')], {
        cwd: tmp, input: '{}', encoding: 'utf8',
        env: { PATH: path.join(d, 'bin') + ':/usr/bin:/bin', HOME: path.join(d, 'home'), ZN_STUB_OUT: '{"decision":"allow"}' },
      });
      assert.strictEqual(r.stdout, '{"decision":"allow"}');
    });

    test('zn-hook.sh does not use a Node.js that is too old', () => {
      const d = fixture('old', { launcher: '// stub', probe: 1 });
      if (hasSystemNode()) return; // a system Node.js outside the PATH would be found (and is a fine answer)
      denied(run(d, {}).r, /no Node\.js 20\.19 or later was found/);
    });

    test('zn-hook.sh answers a deny with no Node.js at all', () => {
      const d = fixture('nonode', { launcher: '// stub', withNode: false });
      if (hasSystemNode()) return;
      denied(run(d, {}).r, /no Node\.js 20\.19 or later was found/);
    });

    test('zn-hook.sh needs no external program to refuse (empty PATH)', () => {
      const d = fixture('nopath', { launcher: '// stub', withNode: false });
      if (hasSystemNode()) return; // found in a usual folder
      const r = spawnSync('/bin/sh', ['-c', 'sh scripts/zn-hook.sh'], { cwd: d, input: '{}', encoding: 'utf8', env: { PATH: '/nonexistent', HOME: '/nonexistent' } });
      denied(r, /no Node\.js 20\.19 or later was found/);
    });

    test('the refusal is valid JSON for every message of the script', () => {
      const text = fs.readFileSync(HOOK, 'utf8');
      for (const m of text.matchAll(/refuse "([^"]*)"/g)) {
        assert.ok(!m[1].includes(String.fromCharCode(92)), 'backslash in: ' + m[1]);
      }
    });

    test('zn-hook.sh has a start deadline under the hook timeout of hooks.json', () => {
      const m = /^DEADLINE=(\d+)$/m.exec(fs.readFileSync(HOOK, 'utf8'));
      assert.ok(m, 'DEADLINE is set');
      const timeout = json('hooks.json')['zn-gate'].PreToolUse[0].hooks[0].timeout;
      assert.ok(Number(m[1]) >= 5 && Number(m[1]) < timeout, 'DEADLINE=' + m[1] + ', timeout ' + timeout);
      assert.ok(timeout < 30, 'below the 30 second default of Antigravity');
    });

    for (const hang of ['probe', 'launch']) {
      test('zn-hook.sh answers a deny at the deadline when Node.js hangs in the ' + hang, () => {
        const d = fixture('hang-' + hang, { launcher: '// stub', deadline: 2 });
        const { r, ms } = run(d, { ZN_STUB_HANG: hang });
        denied(r, /^zn: the hook did not finish starting within 2 seconds/);
        assert.ok(ms >= 1500 && ms < 15000, 'answered at the deadline, not before and not long after: ' + ms + ' ms');
      });
    }

    test('zn-hook.sh with a deadline still lets a fast launcher finish (the deadline is only a cap)', () => {
      const d = fixture('fast-deadline', { launcher: '// stub', deadline: 2 });
      const { r, ms } = run(d, { ZN_STUB_OUT: '{"decision":"allow"}', ZN_STUB_RC: '0' });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, '{"decision":"allow"}');
      assert.ok(ms < 1900, 'the watchdog does not delay a finished hook: ' + ms + ' ms');
    });
  }

  process.stdout.write('1..' + n + '\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
