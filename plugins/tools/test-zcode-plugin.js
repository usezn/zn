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
// The plugin's own start deadline, on every path (zn-hook.sh, zn-hook.ps1 and the launcher), the same as the launcher of zn hooks
// install zcode. On a Windows machine with every CPU busy an ordinary check took up to 131 seconds and a stuck hook ended up to
// 154 seconds after it started, far under ZCode's timeout. It stays above the hook's own 25 second answer deadline.
const PLUGIN_DEADLINE_S = 120;
// The timeout the plugin sets on its hooks in ZCode, which runs a call whose hook timed out. Far above the deadline: on a
// Windows machine with every CPU busy, a stuck hook was blocked after at most 154 seconds (181 for the hooks `zn hooks
// install zcode` writes, with the same timeout).
const PLUGIN_TIMEOUT_MS = 300000;
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
      // Two entries: /bin/sh for macOS and Linux, then the system PowerShell for Windows (the manifest has no platform field,
      // and on each system the other entry cannot start).
      assert.strictEqual(mine[event][0].hooks.length, 2);
      const w = mine[event][0].hooks[1];
      assert.strictEqual(w.type, 'process', event + ': no shell between ZCode and PowerShell');
      assert.strictEqual(w.command, adapter.PLUGIN_WIN_CMD, event + ': cmd.exe by its full path');
      assert.deepStrictEqual(w.args, adapter.pluginWindowsCmdArgs(event));
      assert.strictEqual(w.timeoutMs, PLUGIN_TIMEOUT_MS, event + ' Windows timeout');
      assert.strictEqual(w.statusMessage, adapter.HOOK_STATUS);
      assert.ok(!('onFailure' in w) && !('async' in w) && !('enabled' in w), event + ': a key ZCode does not document or one that turns the hook off');
      const h = mine[event][0].hooks[0];
      assert.strictEqual(h.type, 'process', event + ': no shell between ZCode and sh');
      // By its full path: ZCode looks a bare name up on its PATH, where a relative or empty entry finds the project's files.
      assert.strictEqual(h.command, '/bin/sh');
      assert.deepStrictEqual(h.args, ['${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh', event]);
      assert.strictEqual(h.timeoutMs, PLUGIN_TIMEOUT_MS, event + ' timeout');
      assert.strictEqual(h.statusMessage, adapter.HOOK_STATUS);
      assert.ok(!('onFailure' in h) && !('async' in h) && !('enabled' in h), event + ': a key ZCode does not document or one that turns the hook off');
    }
  });

  test('hooks.json uses only events and tool names ZCode documents', () => {
    const text = fs.readFileSync(path.join(ZC, 'hooks', 'hooks.json'), 'utf8');
    for (const word of ['onFailure', 'UserPromptExpansion', 'MultiEdit', 'NotebookEdit', 'claude-code', 'SessionStart', 'Stop']) {
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

  if (!posix) {
    // The Windows entry of hooks.json, started the way ZCode starts a process hook (no shell, the program and arguments of the
    // manifest with ${ZCODE_PLUGIN_ROOT} filled in, ZCODE_PLUGIN_ROOT set to the plugin folder), against a plugin folder with the
    // real zn-hook.cmd and zn-hook.ps1 and a stub zn-launch.js. The real Node.js runs the stub; no planted file can be mistaken
    // for it. zn-hook.cmd starts Node.js directly when %ProgramFiles%\nodejs\node.exe is a usable Node.js (the fast path) and
    // runs zn-hook.ps1 otherwise (the PowerShell path): wrun takes the PowerShell path unless asked for the fast one, by giving
    // the hook a ProgramFiles folder without Node.js in it.
    const PS1 = path.join(ZC, 'scripts', 'zn-hook.ps1');
    const CMD = path.join(ZC, 'scripts', 'zn-hook.cmd');
    const nodeDir = path.dirname(process.execPath);
    const noPf = path.join(tmp, 'no-program-files');
    fs.mkdirSync(noPf, { recursive: true });
    const fastNode = process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe');
    const fastOk = Boolean(fastNode) && fs.existsSync(fastNode) &&
      spawnSync(fastNode, ['-e', 'process.exit(require("vm").constants && require("vm").constants.USE_MAIN_CONTEXT_DEFAULT_LOADER ? 0 : 1)']).status === 0;
    const PATHS = fastOk ? ['powershell', 'fast'] : ['powershell'];
    const stubLaunch = "let d = '';\nprocess.stdin.on('data', (c) => { d += c; });\nprocess.stdin.on('end', () => {\n  if (process.env.ZN_STUB_HANG === 'launch') { setTimeout(() => {}, 300000); return; }\n  if (process.env.ZN_STUB_MARK) require('fs').writeFileSync(process.env.ZN_STUB_MARK, __filename);\n  process.stdout.write((process.env.ZN_STUB_OUT || '') + (process.env.ZN_STUB_ECHO ? d : ''));\n  process.exit(Number(process.env.ZN_STUB_RC || 0));\n});\n";
    function wfixture(name, { launcher = true, deadline = 120, ps1 = true, cmd = true } = {}) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      if (launcher) fs.writeFileSync(path.join(dir, 'scripts', 'zn-launch.js'), stubLaunch);
      if (cmd) fs.writeFileSync(path.join(dir, 'scripts', 'zn-hook.cmd'), fs.readFileSync(CMD, 'latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
      if (ps1) {
        const text = fs.readFileSync(PS1, 'utf8');
        assert.ok(text.includes('$Deadline = 120'));
        // Test copy only: the shipped script has no setting for the deadline.
        fs.writeFileSync(path.join(dir, 'scripts', 'zn-hook.ps1'), text.replace('$Deadline = 120', '$Deadline = ' + deadline));
      }
      return dir;
    }
    // The program and arguments ZCode starts for an event: ${ZCODE_PLUGIN_ROOT} is replaced with the plugin folder, nothing else.
    function wentry(dir, event) {
      const entry = json('hooks/hooks.json').hooks[event][0].hooks[1];
      return { command: entry.command, args: entry.args.map((a) => a.split('${ZCODE_PLUGIN_ROOT}').join(dir)) };
    }
    function wenv(dir, env, opts) {
      return { SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SystemRoot, ProgramFiles: opts.fast ? process.env.ProgramFiles : noPf, USERPROFILE: path.join(dir, 'home'), PATH: nodeDir + ';' + process.env.SystemRoot + '\\System32', ZCODE_PLUGIN_ROOT: dir, ...env };
    }
    function wrun(dir, event, env = {}, opts = {}) {
      const { command, args } = wentry(dir, event);
      const t0 = Date.now();
      const r = spawnSync(command, args, {
        input: opts.input !== undefined ? opts.input : '{"hook_event_name":"' + event + '"}', encoding: 'utf8', timeout: 60000, cwd: opts.cwd || dir, windowsHide: true,
        env: wenv(dir, env, opts),
      });
      return { r, ms: Date.now() - t0 };
    }
    // The same, started by `parent` (a copy of node.exe) instead of this test process: the hook's chain of parent processes then
    // has no Node.js it may use.
    function wrunFrom(parent, dir, event, env = {}, opts = {}) {
      const { command, args } = wentry(dir, event);
      const relay = "const r = require('child_process').spawnSync(process.argv[1], JSON.parse(process.argv[2]), { stdio: 'inherit', windowsHide: true }); process.exit(r.status === null ? 99 : r.status);";
      return spawnSync(parent, ['-e', relay, command, JSON.stringify(args)], {
        input: '{"hook_event_name":"' + event + '"}', encoding: 'utf8', timeout: 60000, cwd: opts.cwd || dir, windowsHide: true, env: wenv(dir, env, opts),
      });
    }

    for (const via of PATHS) {
      test('the Windows hook (' + via + ' path) passes the answer through from a plugin folder with a space, &, parentheses, ^ or % in its name', () => {
        for (const name of ['w-' + via + ' Jane Doe', 'w-' + via + '-R&D', 'w-' + via + ' Jane Doe (Work) & Co', 'w-' + via + '-a^b', 'w-' + via + '-100%', 'w-' + via + ' J^ne (W&rk) 100%']) {
          const d = wfixture(name);
          const mark = path.join(tmp, 'mark-' + via + '.txt');
          fs.rmSync(mark, { force: true });
          const a = wrun(d, 'PreToolUse', { ZN_STUB_OUT: '{"x":1}', ZN_STUB_MARK: mark }, { fast: via === 'fast' }).r;
          assert.strictEqual(a.status, 0, name + ': ' + a.stderr);
          assert.strictEqual(a.stdout, '{"x":1}', name);
          // Compare real paths: the temp folder can be given in its 8.3 short form (ADMINI~1) and the launcher reports the long one.
          assert.strictEqual(fs.realpathSync.native(fs.readFileSync(mark, 'utf8')).toLowerCase(), fs.realpathSync.native(path.join(d, 'scripts', 'zn-launch.js')).toLowerCase(), name + ': the launcher of that folder ran');
          const b = wrun(d, 'PreToolUse', { ZN_STUB_RC: '2' }, { fast: via === 'fast' }).r;
          assert.strictEqual(b.status, 2, name + ': ' + b.stderr);
          assert.strictEqual(wrun(d, 'PreToolUse', { ZN_STUB_RC: '1' }, { fast: via === 'fast' }).r.status, 2, name);
        }
      });
    }

    test('the Windows hook needs no ZCODE_PLUGIN_ROOT, and never runs a zn-hook.cmd or zn-launch.js of the folder it runs in', () => {
      const d = wfixture('w-own-folder');
      const work = path.join(tmp, 'w-own-folder-project');
      const planted = path.join(tmp, 'w-own-folder-planted.txt');
      for (const sub of ['scripts', path.join('%ZCODE_PLUGIN_ROOT%', 'scripts'), path.join('${ZCODE_PLUGIN_ROOT}', 'scripts')]) {
        fs.mkdirSync(path.join(work, sub), { recursive: true });
        fs.writeFileSync(path.join(work, sub, 'zn-hook.cmd'), '@echo off\r\necho planted> "' + planted + '"\r\nexit /b 0\r\n');
        fs.writeFileSync(path.join(work, sub, 'zn-launch.js'), 'require("fs").writeFileSync(' + JSON.stringify(planted) + ', "planted"); process.exit(0);\n');
      }
      for (const via of PATHS) {
        for (const root of ['', 'scripts', '.']) {
          fs.rmSync(planted, { force: true });
          const mark = path.join(tmp, 'w-own-folder-mark.txt');
          fs.rmSync(mark, { force: true });
          const r = wrun(d, 'PreToolUse', { ZCODE_PLUGIN_ROOT: root, ZN_STUB_MARK: mark, ZN_STUB_OUT: '{"ok":1}' }, { cwd: work, fast: via === 'fast' }).r;
          assert.strictEqual(r.status, 0, via + ' ZCODE_PLUGIN_ROOT=' + root + ': ' + r.stderr);
          assert.strictEqual(r.stdout, '{"ok":1}');
          assert.ok(!fs.existsSync(planted), via + ' ZCODE_PLUGIN_ROOT=' + root + ': a file of the project ran');
          assert.ok(fs.existsSync(mark), via + ': the plugin launcher ran');
        }
      }
    });

    for (const via of PATHS) {
      const o = { fast: via === 'fast' };
      test('the Windows hook (' + via + ' path) passes the launcher answer and exit code 0 or 2 through', () => {
        const d = wfixture('w-pass-' + via);
        const a = wrun(d, 'PreToolUse', { ZN_STUB_OUT: '{"x":1}', ZN_STUB_RC: '0' }, o).r;
        assert.strictEqual(a.status, 0, a.stderr);
        assert.strictEqual(a.stdout, '{"x":1}');
        assert.strictEqual(wrun(d, 'PreToolUse', { ZN_STUB_RC: '2' }, o).r.status, 2);
        // The event JSON reaches the launcher.
        const e = wrun(d, 'PreToolUse', { ZN_STUB_ECHO: '1' }, o).r;
        assert.strictEqual(e.stdout, '{"hook_event_name":"PreToolUse"}');
      });

      test('the Windows hook (' + via + ' path) blocks (exit 2) a blocking event when the launcher fails, and only warns on PostToolUse', () => {
        const d = wfixture('w-fail-' + via);
        for (const event of ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit']) {
          const r = wrun(d, event, { ZN_STUB_RC: '1' }, o).r;
          assert.strictEqual(r.status, 2, event + ' ' + r.stderr);
          assert.ok(/^zn: the hook ended with exit code 1/.test(r.stderr), r.stderr);
        }
        const p = wrun(d, 'PostToolUse', { ZN_STUB_RC: '1' }, o).r;
        assert.strictEqual(p.status, 0, p.stderr);
        assert.ok(/NOT protecting this session/.test(p.stderr), p.stderr);
        assert.strictEqual(wrun(d, 'PreToolUse', { ZN_STUB_RC: '139' }, o).r.status, 2);
      });
    }

    test('the Windows hook blocks when zn-hook.cmd cannot be run, and only warns on PostToolUse', () => {
      const d = wfixture('w-nocmd', { cmd: false });
      for (const event of ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit']) assert.strictEqual(wrun(d, event).r.status, 2, event);
      assert.strictEqual(wrun(d, 'PostToolUse').r.status, 0);
    });

    test('the Windows hook blocks when scripts/zn-launch.js is missing and when zn-hook.ps1 is missing', () => {
      const r = wrun(wfixture('w-nolaunch', { launcher: false }), 'PreToolUse').r;
      assert.strictEqual(r.status, 2, r.stderr);
      assert.ok(/launcher \(scripts\/zn-launch\.js\) is missing/.test(r.stderr), r.stderr);
      const noPs1 = wrun(wfixture('w-nops1', { ps1: false }), 'PreToolUse').r;
      assert.strictEqual(noPs1.status, 2, noPs1.stderr);
      assert.ok(/^zn: the plugin launcher \(scripts\/zn-hook\.ps1\) could not run/.test(noPs1.stderr), noPs1.stderr);
      assert.strictEqual(wrun(wfixture('w-nops1b', { ps1: false }), 'PostToolUse').r.status, 0);
    });

    test('the Windows hook runs under a Restricted execution policy and with an apostrophe or a space in the plugin folder', () => {
      const d = wfixture("w-it's a folder");
      const r = wrun(d, 'PreToolUse', { ZN_STUB_OUT: '{"y":2}' }).r;
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(r.stdout, '{"y":2}');
    });

    test('the Windows hook blocks when there is no Node.js 20.19 or later at all, and warns only on PostToolUse', () => {
      // Node.js is hidden from the hook whatever is installed on this machine: no PATH entry has a node.exe, the usual install
      // folders point to empty folders, and the hook is started by a copy of node.exe inside a node_modules folder (a folder the
      // hook never takes a program from), so the chain of parent processes has no Node.js it may use either. On a machine with
      // Node.js installed (CI) this runs too.
      const d = wfixture('w-nonode');
      const relayDir = path.join(tmp, 'w-nonode-relay', 'node_modules', '.bin');
      fs.mkdirSync(relayDir, { recursive: true });
      const relay = path.join(relayDir, 'node.exe');
      fs.copyFileSync(process.execPath, relay);
      const hidden = { PATH: process.env.SystemRoot + '\\System32', 'ProgramFiles(x86)': noPf, LOCALAPPDATA: noPf, ZN_STUB_OUT: '{"ran":1}' };
      const r = wrunFrom(relay, d, 'PreToolUse', hidden);
      assert.strictEqual(r.status, 2, r.stderr);
      assert.ok(/no Node\.js 20\.19 or later was found/.test(r.stderr), r.stderr);
      assert.ok(!r.stdout.includes('"ran"'), 'the launcher ran: ' + r.stdout);
      const p = wrunFrom(relay, d, 'PostToolUse', hidden);
      assert.strictEqual(p.status, 0, p.stderr);
      assert.ok(/NOT protecting this session/.test(p.stderr), p.stderr);
      // Control: the same start with Node.js on the PATH runs the launcher.
      const c = wrunFrom(relay, d, 'PreToolUse', { ...hidden, PATH: nodeDir + ';' + process.env.SystemRoot + '\\System32' });
      assert.strictEqual(c.status, 0, c.stderr);
      assert.strictEqual(c.stdout, '{"ran":1}');
    });

    test('the Windows hook never starts a node.exe from a relative or empty PATH entry, or from a folder inside the project', () => {
      const d = wfixture('w-planted');
      const work = path.join(tmp, 'w-planted-work');
      const marker = path.join(tmp, 'w-planted-ran.txt');
      // Every node that starts records the program it is (NODE_OPTIONS), so a copy of node.exe planted in the project shows.
      const rec = path.join(tmp, 'w-planted-rec.js');
      fs.writeFileSync(rec, 'require("fs").appendFileSync(' + JSON.stringify(marker) + ', process.execPath + "\\n");\n');
      const bin = path.join(work, 'bin');
      const nm = path.join(work, 'node_modules', '.bin');
      for (const dir of [work, bin, nm, path.join(work, '.git')]) fs.mkdirSync(dir, { recursive: true });
      for (const dir of [work, bin, nm]) fs.copyFileSync(process.execPath, path.join(dir, 'node.exe'));
      const real = nodeDir;
      const sys = process.env.SystemRoot + '\\System32';
      for (const PATH of ['.;' + real + ';' + sys, 'bin;' + real + ';' + sys, ';' + real + ';' + sys, bin + ';' + real + ';' + sys, nm + ';' + real + ';' + sys, real + ';' + bin]) {
        fs.rmSync(marker, { force: true });
        const r = wrun(d, 'PreToolUse', { PATH, ZN_STUB_OUT: '{"decision":"allow"}', NODE_OPTIONS: '--require ' + rec.split('\\').join('/') }, { cwd: work }).r;
        assert.strictEqual(r.status, 0, PATH + ': ' + r.stderr);
        assert.strictEqual(r.stdout, '{"decision":"allow"}', PATH);
        const ran = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
        assert.ok(ran.length > 0, PATH + ': the node.exe run was not recorded');
        assert.ok(!ran.toLowerCase().includes(work.toLowerCase()), PATH + ': a node.exe planted in the project ran: ' + ran);
      }
    });

    for (const hang of ['launch']) {
      test('the Windows hook blocks at the deadline when Node.js hangs in the ' + hang + ' (and only warns on PostToolUse)', () => {
        const d = wfixture('w-hang-' + hang, { deadline: 3 });
        const { r, ms } = wrun(d, 'PreToolUse', { ZN_STUB_HANG: hang });
        assert.strictEqual(r.status, 2, r.stderr);
        assert.ok(/^zn: the hook did not finish starting within 3 seconds/.test(r.stderr), r.stderr);
        assert.ok(ms >= 1500 && ms < 20000, 'answered at the deadline, not before and not long after: ' + ms + ' ms');
        const p = wrun(d, 'PostToolUse', { ZN_STUB_HANG: hang });
        assert.strictEqual(p.r.status, 0);
        assert.ok(/NOT protecting this session/.test(p.r.stderr), p.r.stderr);
      });
    }

    test('zn-hook.ps1 has a start deadline far under the timeout the plugin sets in ZCode', () => {
      const m = /^\$Deadline = (\d+)$/m.exec(fs.readFileSync(PS1, 'utf8'));
      assert.ok(m, 'Deadline is set');
      assert.strictEqual(Number(m[1]), PLUGIN_DEADLINE_S);
    });
  }

  // The Windows hook runs under scripts/zn-hook.cmd, so the process that started the PowerShell script is cmd.exe, not ZCode.
  // Measured on the ZCode desktop app 3.16.3: a fallback that took the parent as Node.js and trusted exit code 0 ran cmd.exe as
  // "node", which read the event as commands and let every call through. These checks run on every system.
  test('zn-hook.ps1 never takes a shell or script host for Node.js, and reads the version Node.js prints', () => {
    const text = fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.ps1'), 'utf8');
    assert.ok(/ZNPROBE/.test(text) && /function VersionOk/.test(text), 'the probe prints a version that is parsed');
    assert.ok(!/return \(\$p\.ExitCode -eq 0\)/.test(text), 'the exit code alone never decides');
    for (const shell of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'wscript.exe', 'cscript.exe', 'bash.exe', 'sh.exe']) {
      assert.ok(text.includes("'" + shell + "'"), shell + ' is skipped as a parent');
    }
    assert.ok(/\$lvl -lt 6/.test(text), 'the chain of parents is walked up, with a limit');
    assert.ok(/Refuse 'no Node\.js 20\.19 or later was found/.test(text), 'with no valid Node.js the hook blocks');
  });

  // ZCode starts hooks in the project folder, where Windows looks for a program by name first: the launcher names every program it
  // starts by full path. The PowerShell script counts its deadline from the start of its process.
  test('zn-hook.cmd starts programs by full path only, and zn-hook.ps1 counts its deadline from the process start', () => {
    const cmd = fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.cmd'), 'utf8').split(/\r?\n/).filter((l) => !/^\s*rem\b/i.test(l));
    for (const l of cmd) {
      assert.ok(!/(^|[\s(&|])(powershell|pwsh|cmd|node|python|wscript|cscript)(\.exe)?\s/i.test(l.replace(/"[^"]*"/g, '""')), 'a program started by name: ' + l);
    }
    assert.ok(!cmd.some((l) => /\bstart\b/i.test(l)), 'nothing runs in the background');
    const ps = fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.ps1'), 'utf8');
    assert.ok(/GetCurrentProcess\(\)\.StartTime/.test(ps) && /\$Deadline - /.test(ps), 'the deadline is what is left of 120 seconds since the process started');
    // Windows PowerShell finds a command (Get-Date, New-Object, Get-CimInstance, ...) by reading its module folders, which
    // without the module cache can take many seconds: the script calls only its own functions, the language and .NET.
    const code = ps.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    const own = new Set([...code.matchAll(/^function ([A-Za-z]+-[A-Za-z]+)/gm)].map((m) => m[1]));
    const commands = [...code.matchAll(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/g)].map((m) => m[0]).filter((c) => !own.has(c));
    assert.deepStrictEqual(commands, [], 'PowerShell commands that are looked up in modules');
    // The parents are read one process at a time, with a wait that ends before the deadline.
    assert.ok(/\[wmisearcher\]\('SELECT ParentProcessId FROM Win32_Process WHERE ProcessId = '/.test(ps), 'one process per query');
    assert.ok(/AsyncWaitHandle\.WaitOne\(\$wait\)/.test(ps) && /\$wait = \(Left\) - 2000/.test(ps), 'the parent lookup has a time limit');
  });

  // ZCode's timeout starts when it starts cmd.exe, and the call runs when the hook times out. zn-hook.cmd notes the time
  // on its first command line; zn-hook.ps1 counts its deadline from there (or from its own start, whichever is earlier), never
  // gives itself time past it, and tries only the first parent that is not a shell.
  test('the Windows hook counts its deadline from the start of zn-hook.cmd and blocks when no time is left', () => {
    const cmd = fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.cmd'), 'utf8').split(/\r?\n/).filter((l) => l && !/^\s*(rem\b|@echo off)/i.test(l));
    assert.strictEqual(cmd[0], 'set "ZN_HOOK_T0=%TIME%"', 'the start time is taken before anything else');
    const ps = fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.ps1'), 'utf8');
    assert.ok(/\$env:ZN_HOOK_T0/.test(ps), 'the PowerShell script reads the start time of zn-hook.cmd');
    assert.ok(/if \(\$e -gt \$Since -and \$e -lt 120\) \{ \$Since = \$e \}/.test(ps), 'ZN_HOOK_T0 can only make the deadline shorter');
    assert.ok(/\[Math\]::Max\(0, \$Deadline - /.test(ps) && !/\[Math\]::Max\(3,/.test(ps), 'no extra seconds past the deadline');
    assert.ok(/if \(\$Deadline -le 0\) \{ Refuse /.test(ps), 'a start that used up the time blocks at once');
    assert.ok(/if \(TryNode \$exe\) \{ \$Node = \$exe; \$AppNode = \$true \}\r?\n\s*break\r?\n/.test(ps), 'only the first parent that is not a shell is tried');
  });

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
      assert.ok(/^DEADLINE=120$/m.test(text));
      // Test copy only: the shipped script has no setting for the deadline.
      fs.writeFileSync(path.join(dir, 'scripts', 'zn-hook.sh'), text.replace(/^DEADLINE=120$/m, 'DEADLINE=' + deadline));
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

    test('zn-hook.sh never starts a program from an absolute PATH entry inside the project (bin/, node_modules/.bin, a link, the git work tree)', () => {
      const d = fixture2('abspath', 28);
      const work = path.join(tmp, 'abspath-work');
      const marker = path.join(tmp, 'abspath-ran');
      const bin = path.join(work, 'bin');
      const nm = path.join(work, 'node_modules', '.bin');
      for (const dir of [bin, nm, path.join(work, '.git'), path.join(work, 'sub')]) fs.mkdirSync(dir, { recursive: true });
      for (const dir of [bin, nm]) {
        for (const n of ['node', 'sleep', 'ps', 'readlink', 'ls', 'sort', 'cat']) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n: > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
      }
      const linkdir = path.join(tmp, 'abspath-linkdir');
      fs.symlinkSync(bin, linkdir);
      const linknode = path.join(tmp, 'abspath-linknode');
      fs.mkdirSync(linknode);
      fs.symlinkSync(path.join(bin, 'node'), path.join(linknode, 'node'));
      const real = path.join(d, 'bin');
      const cases = [[work, bin], [path.join(work, 'sub'), bin], [work, nm], [work, linkdir], [work, linknode]];
      for (const [cwd, bad] of cases) {
        for (const PATH of [bad + ':' + real + ':/usr/bin:/bin', real + ':' + bad + ':/usr/bin:/bin']) {
          const r = spawnSync('/bin/sh', [fixedScript('cd-sh', 'cd "$2" && sh "$1" PreToolUse'), path.join(d, 'scripts', 'zn-hook.sh'), cwd], {
            input: '{"hook_event_name":"PreToolUse"}', encoding: 'utf8', timeout: 30000,
            env: { PATH, HOME: path.join(d, 'home'), ZN_STUB_OUT: '{"decision":"allow"}' },
          });
          assert.strictEqual(fs.existsSync(marker), false, cwd + ' ' + PATH + ': a planted program ran');
          assert.strictEqual(r.status, 0, cwd + ' ' + PATH + ': ' + r.stderr);
          assert.strictEqual(r.stdout, '{"decision":"allow"}', PATH);
        }
      }
    });

    test('zn-hook.sh has a start deadline far under the timeout the plugin sets in ZCode', () => {
      const m = /^DEADLINE=(\d+)$/m.exec(fs.readFileSync(HOOK, 'utf8'));
      assert.ok(m, 'DEADLINE is set');
      assert.strictEqual(Number(m[1]), PLUGIN_DEADLINE_S, 'DEADLINE is the plugin deadline');
      assert.ok(Number(m[1]) <= adapter.LAUNCHER_DEADLINE_S, 'DEADLINE is not later than the launcher deadline of zn hooks install zcode');
      assert.ok(Number(m[1]) * 1000 * 2 <= adapter.ENTRY_TIMEOUT_MS, 'room to stop a stuck hook before ZCode gives up');
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

  // scripts/zn-hook.cmd (the entry hooks.json runs on Windows): it cannot run here, so these read it. The Windows tests below run it.
  {
    const cmdText = fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.cmd'), 'latin1');
    const ps1Text = fs.readFileSync(path.join(ZC, 'scripts', 'zn-hook.ps1'), 'latin1');
    const adapterMsg = adapter.pluginWindowsArgs('PreToolUse')[3];
    test('zn-hook.cmd has CRLF line ends (labels and goto fail with bare LF) and only ASCII', () => {
      assert.ok(!/(^|[^\r])\n/.test(cmdText), 'a bare LF');
      assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(cmdText), 'non ASCII');
    });
    test('zn-hook.cmd refuses with the same words as the PowerShell launcher and the inline command of hooks.json', () => {
      const block = /This call was blocked because zn could not check it\. Ask the user to fix it, or to turn off the zn-gate plugin in ZCode/;
      assert.match(cmdText, block);
      assert.match(ps1Text, block);
      assert.ok(cmdText.includes('zn is NOT protecting this session: '));
      assert.ok(ps1Text.includes('zn is NOT protecting this session: '));
      // The fallback runs the same inline command as the manifest entry, with the event and the exit code filled in.
      // The fallback runs the inline command of the earlier manifest entry, reading zn-hook.ps1 from the folder of zn-hook.cmd.
      const inline = adapter.pluginWindowsArgs('PreToolUse')[3];
      const head = inline.slice(0, inline.indexOf("'PreToolUse'")).replace("$env:ZCODE_PLUGIN_ROOT + '/scripts/zn-hook.ps1'", "$env:ZN_HOOK_DIR + 'zn-hook.ps1'");
      assert.ok(cmdText.includes(head), 'inline command differs from pluginWindowsArgs');
      assert.ok(adapterMsg.includes('the plugin launcher (scripts/zn-hook.ps1) could not run. This call was blocked'));
    });
    test('zn-hook.cmd only passes exit codes 0 and 2 through, and a link or an unsuitable Node.js is not used', () => {
      assert.match(cmdText, /if "%ZN_RC%"=="0" exit \/b 0/);
      assert.match(cmdText, /if "%ZN_RC%"=="2" exit \/b 2/);
      assert.match(cmdText, /dir \/a:l \/b "%ZN_NODE%" >nul 2>nul && goto :slow/);
      assert.match(cmdText, /USE_MAIN_CONTEXT_DEFAULT_LOADER/);
      assert.ok(!/%PATH%/i.test(cmdText), 'the fast path never searches the PATH');
    });
    test('zn-hook.cmd names its files from its own folder, never from ZCODE_PLUGIN_ROOT or the working folder, and only inside quotes', () => {
      const code = cmdText.split(/\r\n/).filter((l) => !/^\s*rem\b/i.test(l));
      assert.ok(code.includes('set "ZN_HOOK_DIR=%~dp0"'), 'the folder of the file');
      assert.ok(!code.some((l) => /ZCODE_PLUGIN_ROOT/i.test(l)), 'ZCODE_PLUGIN_ROOT is not used');
      for (const l of code.filter((x) => /%ZN_HOOK_DIR%/.test(x))) {
        assert.ok(/"%ZN_HOOK_DIR%zn-launch\.js"/.test(l) && !/(^|[^"])%ZN_HOOK_DIR%/.test(l), 'the folder only inside quotes: ' + l);
      }
      assert.ok(code.some((l) => /\$env:ZN_HOOK_DIR \+ 'zn-hook\.ps1'/.test(l)), 'PowerShell reads the folder from the environment, not from the command line');
      assert.ok(code.includes('if not defined ProgramFiles goto :slow'), 'no ProgramFiles: the PowerShell path');
      assert.ok(code.includes('if not defined SystemRoot set "SystemRoot=C:\\Windows"'), 'a default for SystemRoot');
      assert.ok(!code.some((l) => /(^|[(&|])\s*call\s/i.test(l)), 'no call (it doubles ^ and expands % again)');
    });

    test('both Windows paths have the same deadline, and the README says which', () => {
      const launch = fs.readFileSync(path.join(ROOT, 'plugins', 'zn-gate', 'scripts', 'zn-launch.js'), 'utf8');
      const m = /const HOOK_DEADLINE_MS = \{ zcode: (\d+) \};/.exec(launch);
      assert.ok(m, 'the launcher has a deadline for the zcode hook (the fast path starts it directly)');
      assert.strictEqual(Number(m[1]), PLUGIN_DEADLINE_S * 1000);
      assert.ok(/^\$Deadline = (\d+)$/m.exec(ps1Text)[1] === String(PLUGIN_DEADLINE_S), 'the PowerShell path');
      assert.ok(/process\.env\.ZN_HOOK_T0/.test(launch), 'the launcher counts from the start of zn-hook.cmd too');
      const readme = fs.readFileSync(path.join(ZC, 'README.md'), 'utf8').replace(/\s+/g, ' ');
      assert.ok(readme.includes('if zn has not answered ' + PLUGIN_DEADLINE_S + ' seconds after the hook started, the hook blocks the call'), 'README');
      assert.ok(!/same deadline/.test(readme), 'README');
    });

    // How the Windows entry reaches cmd.exe. ZCode starts a process hook with Node.js (no shell): ${ZCODE_PLUGIN_ROOT} is replaced
    // with the plugin folder and Windows gets one command line, built by quoting every argument that holds a space, a tab or a
    // double quote (libuv's rule, written out below). cmd.exe /c then reads that line: outside double quotes, & | < > ( ) ^ are
    // its own characters, so the plugin folder must be inside one pair of quotes, and the line must not start with a quote.
    const quoteArg = (a) => {
      if (a === '') return '""';
      if (!/[ \t"]/.test(a)) return a;
      if (!/["\\]/.test(a)) return '"' + a + '"';
      let out = '';
      let quoteHit = true;
      for (let i = a.length - 1; i >= 0; i--) {
        out += a[i];
        if (quoteHit && a[i] === '\\') out += '\\';
        else if (a[i] === '"') { quoteHit = true; out += '\\'; } else quoteHit = false;
      }
      return '"' + out.split('').reverse().join('') + '"';
    };
    test('the Windows entry keeps a plugin folder with a space, &, parentheses, ^ or % in its name inside one pair of quotes', () => {
      for (const event of ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'PostToolUse']) {
        const w = json('hooks/hooks.json').hooks[event][0].hooks[1];
        assert.ok(w.args.every((a) => !/%ZCODE_PLUGIN_ROOT%/i.test(a) && a.toLowerCase() !== 'call'), event + ': no %ZCODE_PLUGIN_ROOT% and no call');
        assert.strictEqual(w.args.filter((a) => a.includes('${ZCODE_PLUGIN_ROOT}')).length, 1, event + ': the folder ZCode fills in, once');
        for (const root of ['C:\\Users\\jdoe\\.zcode\\cli\\plugins\\cache\\usezn\\zn-gate\\1.15.0', 'C:\\Users\\Jane Doe\\x', 'C:\\Users\\R&D\\x',
          'C:\\Users\\Jane Doe (Work) & Co\\x', 'C:\\Users\\a^b\\x', 'C:\\Users\\100%\\x', 'C:\\Users\\J^ne (W&rk) 100%\\x', 'C:\\Users\\x|y<z>\\x']) {
          const line = [w.command, ...w.args.map((a) => a.split('${ZCODE_PLUGIN_ROOT}').join(root))].map(quoteArg).join(' ');
          const after = line.slice(line.indexOf(' /c ') + 4);
          assert.notStrictEqual(after[0], '"', 'the line after /c must not start with a quote');
          const code = event === 'PostToolUse' ? '0' : '2';
          assert.strictEqual(after, '( "' + root + '\\scripts\\zn-hook.cmd " ' + event + ' ) || exit /b ' + code, root);
          // Everything outside the one pair of quotes is the fixed text of the manifest.
          assert.strictEqual((after.match(/"/g) || []).length, 2, root);
          assert.strictEqual(after.replace(/"[^"]*"/, '""'), '( "" ' + event + ' ) || exit /b ' + code, root);
        }
      }
    });
  }

  process.stdout.write('1..' + n + '\n');
} finally {
  // On Windows a hook process killed at its deadline can still hold the folder for a moment; the tests are done,
  // so cleaning up must retry and never turn a green run red.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    if (process.platform !== 'win32') throw e;
    process.stderr.write('note: could not remove ' + tmp + ': ' + e.code + '\n');
  }
}
