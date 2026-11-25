'use strict';

// The plugin hook scripts (scripts/zn-node.sh of the Claude Code and Codex plugin, scripts/zn-hook.sh and zn-hook.ps1 of the
// ZCode plugin) start Node.js with the agent's environment, which a project can set. NODE_OPTIONS=--require, NODE_PATH and the
// other loader variables must be gone before Node.js starts, or a preload would run inside the hook before zn-launch.js checks
// anything. Every value here is a benign marker: a preload that only writes a marker file, and a stub launcher that only
// reports which variables it saw and answers like an allowed call. Nothing destructive is run.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// Started, not looked up: on Windows /bin/sh is /bin/sh.exe, which fs.existsSync does not find.
const shellStarts = (sh) => { try { return spawnSync(sh, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0; } catch { return false; } };

const loaderEnv = require('../lib/loader-env');
const { tempDir } = require('./helpers/tmp');
const { hasPosixSh: posix } = require('./helpers/posix_sh');

const PLUGINS = path.join(__dirname, '..', '..', '..', 'plugins');
const ZN_NODE_SH = path.join(PLUGINS, 'zn-gate', 'scripts', 'zn-node.sh');
const ZCODE_SH = path.join(PLUGINS, 'zcode', 'scripts', 'zn-hook.sh');
const ZCODE_PS1 = path.join(PLUGINS, 'zcode', 'scripts', 'zn-hook.ps1');
// A Windows checkout may turn the line ends of the scripts into CRLF.
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

// Stands in for scripts/zn-launch.js: reports the loader-related names it got and answers like an allowed call.
const STUB_LAUNCH = "const fs = require('fs');" +
  "const seen = Object.keys(process.env).filter((k) => /^(node_|ld_|dyld_|https_proxy$|bash_env$|env$|openssl_conf$)/i.test(k)).sort();" +
  "fs.writeFileSync(process.env.ZN_TEST_SEEN, JSON.stringify(seen));" +
  "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('{}\\n'); process.exit(0); });\n";
const PRELOAD = "require('fs').appendFileSync(process.env.ZN_TEST_MARKER, 'preloaded\\n');\n";

function fixture(t) {
  const dir = fs.realpathSync(tempDir(t, 'zn-plugin-env-'));
  const plugin = path.join(dir, 'plugin');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.copyFileSync(ZN_NODE_SH, path.join(plugin, 'scripts', 'zn-node.sh'));
  fs.writeFileSync(path.join(plugin, 'scripts', 'zn-launch.js'), STUB_LAUNCH);
  // The hook runs in a folder of its own, so the folder of the test's Node.js is not taken for the project.
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const libdir = path.join(dir, 'lib');
  fs.mkdirSync(libdir);
  const pre = path.join(dir, 'pre.cjs');
  fs.writeFileSync(pre, PRELOAD);
  // NODE_PATH points at a folder with a module named like a core-less bare require; it must not be the lookup path either.
  fs.writeFileSync(path.join(libdir, 'zn-test-planted.js'), PRELOAD);
  return { dir, plugin, work, pre, libdir, marker: path.join(dir, 'marker.txt'), seen: path.join(dir, 'seen.json') };
}

function hostileEnv(f) {
  return {
    PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
    HOME: f.dir,
    ZN_TEST_MARKER: f.marker,
    ZN_TEST_SEEN: f.seen,
    NODE_OPTIONS: '--require ' + f.pre,
    NODE_PATH: f.libdir,
    NODE_REPL_EXTERNAL_MODULE: f.pre,
    BASH_ENV: path.join(f.dir, 'bashenv'),
    Node_Options: '--require ' + f.pre,
    // Kept: they load no code.
    NODE_EXTRA_CA_CERTS: path.join(f.dir, 'extra-ca.pem'),
    HTTPS_PROXY: 'http://proxy.example.invalid:3128',
  };
}

test('sanity: the preload runs when Node.js is started with the hostile environment directly', (t) => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8', env: hostileEnv(f) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(f.marker, 'utf8'), /preloaded/);
});

for (const shell of ['/bin/sh', '/bin/bash']) {
  test('plugin zn-node.sh run by ' + shell + ': NODE_OPTIONS and NODE_PATH do not reach Node.js, the hook still answers', { skip: (!posix || !shellStarts(shell) || process.execPath.includes('/node_modules/')) ? shell + ' does not start on this system, or Node.js runs from a package folder' : false }, (t) => {
    const f = fixture(t);
    const sh = path.join(f.plugin, 'scripts', 'zn-node.sh');
    const r = spawnSync(shell, [sh, 'PreToolUse', 'hook', 'claude-code'], { input: '{"tool_name":"Read"}', encoding: 'utf8', cwd: f.work, env: hostileEnv(f) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '{}');
    assert.equal(fs.existsSync(f.marker), false, 'a preload ran inside the hook');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.seen, 'utf8')), ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']);
  });
}

test('plugin sh scripts: the shared scrub comes before the first program the script starts', () => {
  const scrub = loaderEnv.shScrubLines().join('\n');
  for (const [file, firsts] of [[ZN_NODE_SH, ['EVENT=', '$(', '"$NODE"']], [ZCODE_SH, ['EVENT=', '$(', '"$NODE"']]]) {
    const text = read(file);
    assert.ok(text.startsWith('#!/bin/sh\n'), file);
    const at = text.indexOf(scrub);
    assert.ok(at > 0, path.basename(file) + ': the scrub lines of lib/loader-env.js are in the script (copy them again if the list changed)');
    for (const first of firsts) assert.ok(text.indexOf(first) > at, path.basename(file) + ': ' + first + ' comes after the scrub');
  }
});

test('ZCode zn-hook.ps1 (static: not run on Windows here): every Node.js it starts gets an environment without the loader variables', () => {
  const text = read(ZCODE_PS1);
  const m = text.match(/function New-Info\([^)]*\) \{\n([\s\S]*?)\n  return \$i\n\}/);
  assert.ok(m, 'New-Info is there');
  const want = "  foreach ($n in @(" + loaderEnv.WINDOWS_NAMES.map((n) => "'" + n + "'").join(', ') + ")) { [void]$i.EnvironmentVariables.Remove($n) }";
  assert.ok(m[1].split('\n').includes(want), 'New-Info removes ' + loaderEnv.WINDOWS_NAMES.join(', '));
  assert.doesNotMatch(m[1].split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /NODE_EXTRA_CA_CERTS|PROXY/);
  // Every process the script starts (the version probe and the launch) is built by New-Info.
  assert.equal((text.match(/ProcessStartInfo\]::new\(/g) || []).length, 1, 'only New-Info makes a ProcessStartInfo');
  const starts = text.match(/\[System\.Diagnostics\.Process\]::Start\([^)]*\)/g) || [];
  assert.ok(starts.length >= 2, 'the probe and the launch');
  for (const call of starts) assert.equal(call, '[System.Diagnostics.Process]::Start($i)');
  assert.equal((text.match(/\$i = New-Info /g) || []).length, starts.length, 'each start uses an info from New-Info');
  assert.doesNotMatch(text, /Start-Process|& \$Node\b/);
});
