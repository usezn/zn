'use strict';

// The hook launchers (the sh script, the Windows PowerShell command and the OpenCode plugin) start Node.js with the agent's
// environment, which a project can set. Variables that make Node.js or the dynamic loader load code of the caller's choosing
// (NODE_OPTIONS=--require or --import, LD_PRELOAD and the like) must not reach the hook: such code would run inside the hook,
// where it could answer for it. Every value here is a benign marker: a preload that only writes a marker file, and a stub
// runner that only reports which variables it saw. Nothing destructive is run.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// Started, not looked up: on Windows /bin/sh is /bin/sh.exe, which fs.existsSync does not find.
const shellStarts = (sh) => { try { return spawnSync(sh, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0; } catch { return false; } };
const { pathToFileURL } = require('url');

const launcher = require('../lib/agents/launcher');
const opencode = require('../lib/agents/opencode');
const loaderEnv = require('../lib/loader-env');
const { _internal: checkInternal } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');
const { hasPosixSh: posix } = require('./helpers/posix_sh');

// Reports the names of the environment it got (only the ones this test sets) and confirms its answer like the real runner.
const RUNNER = "const fs = require('fs');" +
  "const seen = Object.keys(process.env).filter((k) => /^(node_|ld_|dyld_|https_proxy$|bash_env$|env$|openssl_conf$|gconv_path$)/i.test(k)).sort();" +
  "fs.writeFileSync(process.env.ZN_TEST_SEEN, JSON.stringify(seen));" +
  "if (process.env.ZN_HOOK_ACK) fs.writeFileSync(process.env.ZN_HOOK_ACK, 'ok');" +
  "process.stdout.write('{}\\n');\n";
const PRELOAD_CJS = "require('fs').appendFileSync(process.env.ZN_TEST_MARKER, 'require\\n');\n";
const PRELOAD_MJS = "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.ZN_TEST_MARKER, 'import\\n');\n";

function fixture(t) {
  const dir = tempDir(t, 'zn-hook-env-');
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, RUNNER);
  const pre = path.join(dir, 'pre.cjs');
  fs.writeFileSync(pre, PRELOAD_CJS);
  const preM = path.join(dir, 'pre.mjs');
  fs.writeFileSync(preM, PRELOAD_MJS);
  return { dir, runner, pre, preM, marker: path.join(dir, 'marker.txt'), seen: path.join(dir, 'seen.json') };
}

function hostileEnv(f, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: f.dir,
    TMPDIR: f.dir,
    ZN_TEST_MARKER: f.marker,
    ZN_TEST_SEEN: f.seen,
    NODE_OPTIONS: '--require ' + f.pre + ' --import ' + pathToFileURL(f.preM).href,
    NODE_PATH: f.dir,
    NODE_V8_COVERAGE: path.join(f.dir, 'cov'),
    LD_LIBRARY_PATH: path.join(f.dir, 'libs'),
    DYLD_LIBRARY_PATH: path.join(f.dir, 'libs'),
    // LD_PRELOAD, LD_AUDIT and DYLD_INSERT_LIBRARIES are not here: the launcher refuses to run with one set (they load into the
    // shell before its first line), see hooks_launcher_preload.test.js. Names that are not in the list are left alone on Linux and macOS (the scrub there is `unset` of the listed names only).
    BASH_ENV: path.join(f.dir, 'bashenv'),
    ENV: path.join(f.dir, 'shenv'),
    OPENSSL_CONF: path.join(f.dir, 'openssl.cnf'),
    // Windows reads names in any case; the sh launcher (Git Bash) must catch these too.
    ...(process.platform === 'win32' ? { Node_Options: '--require ' + f.pre } : {}),
    // Kept: they load no code.
    NODE_EXTRA_CA_CERTS: path.join(f.dir, 'extra-ca.pem'),
    HTTPS_PROXY: 'http://proxy.example.invalid:3128',
    ...extra,
  };
}

test('sanity: the preloads in the hostile environment do run when Node.js is started with it directly', (t) => {
  const f = fixture(t);
  const env = hostileEnv(f);
  for (const k of ['LD_PRELOAD', 'OPENSSL_CONF', 'NODE_EXTRA_CA_CERTS']) delete env[k];
  const r = spawnSync(process.execPath, [f.runner], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const marks = fs.readFileSync(f.marker, 'utf8');
  assert.match(marks, /require/);
  assert.match(marks, /import/);
});

for (const shell of ['/bin/sh', '/bin/bash']) {
  test('sh launcher run by ' + shell + ': no loader variable reaches the hook, nothing preloads, CA and proxy settings stay', { skip: !posix || !shellStarts(shell) ? shell + ' does not start on this system' : false }, (t) => {
    const f = fixture(t);
    const file = path.join(f.dir, 'zn-hook-claude-code.sh');
    fs.writeFileSync(file, launcher.unixScript('claude-code', process.execPath, f.runner, { manifest: '' }), { mode: 0o755 });
    const r = spawnSync(shell, [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: hostileEnv(f) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '{}');
    assert.equal(fs.existsSync(f.marker), false, 'a preload ran inside the hook');
    // ld.so names a preload it cannot load on stderr of every program it starts: once for the shell itself (started here with
    // the variable), and once more for each program the launcher starts (mktemp, node, cat, rm) if it were still set.
    assert.ok((r.stderr.match(/missing-zn-test\.so/g) || []).length <= 1, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.seen, 'utf8')), ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']);
  });
}

test('sh launcher: the scrub comes before the first program the script starts and uses the shared list', () => {
  const text = launcher.unixScript('codex', '/usr/bin/node', '/opt/zn/lib/hooks/runner.js', { runnerDigest: 'a'.repeat(64), manifest: '', deadlineS: 5 });
  const lines = text.split('\n');
  assert.equal(lines[0], '#!/bin/sh');
  assert.match(lines[1], /^# Written by `zn hooks install codex`; replaced on every install\. Do not edit\.$/);
  const scrub = loaderEnv.shScrubLines({ fast: process.platform !== 'win32' }).join('\n');
  const at = text.indexOf(scrub);
  assert.ok(at > 0, 'the scrub lines are in the launcher');
  for (const first of ['ZN_EVENT=', 'zn_mk ack', '"$ZN_NODE"']) assert.ok(text.indexOf(first) > at, first + ' comes after the scrub');
  for (const n of loaderEnv.LOADER_NAMES) assert.ok(text.includes(' ' + n + ' ') || text.includes(' ' + n + '\n'), n + ' is unset');
  const code = loaderEnv.shScrubLines({ fast: process.platform !== 'win32' }).filter((l) => !l.startsWith('#')).join('\n');
  assert.doesNotMatch(code, /NODE_EXTRA_CA_CERTS|PROXY/);
});

test('Windows launcher (PowerShell, static: not run on Windows here): the loader variables are removed before Node.js starts', () => {
  for (const [agent, event, opts] of [['cursor', 'preToolUse', {}], ['gemini', 'BeforeTool', {}], ['codex', 'PreToolUse', {}], ['zcode', 'PreToolUse', { deadlineS: 8 }]]) {
    const s = launcher.windowsScript(agent, event, 'C:/Program Files/nodejs/node.exe', 'C:/Users/u/AppData/Roaming/npm/node_modules/zn-gate/lib/hooks/runner.js', opts);
    assert.ok(s, agent);
    const scrub = loaderEnv.psScrub();
    const at = s.indexOf(scrub);
    assert.ok(at > 0, agent + ': the scrub is in the script');
    // No cmdlet (Remove-Item, Get-ChildItem ...): each name is set to $null, which removes it.
    assert.doesNotMatch(scrub, /Remove-Item|Get-ChildItem|Env:\\|-Path/);
    assert.equal(scrub, "$env:NODE_OPTIONS=$null; $env:NODE_PATH=$null; $env:OPENSSL_CONF=$null; ");
    for (const start of ["& 'C:", '$rc = zr ', "& (zf 'zn.cmd')"]) {
      const i = s.indexOf(start);
      if (i >= 0) assert.ok(i > at, agent + ': ' + start + ' comes after the scrub');
    }
    // The names come from the shared list (Windows has no LD_ or DYLD_ loader).
    for (const n of loaderEnv.WINDOWS_NAMES) assert.ok(loaderEnv.LOADER_NAMES.includes(n), n);
    assert.doesNotMatch(scrub, /NODE_EXTRA_CA_CERTS|PROXY/);
    // The ack file is still removed on every way out: zx goes through zd.
    assert.match(s, /function zx\(\$c\) \{ zd; exit \$c \}; function zd \{ try \{ if \(\$za\) \{ \[System\.IO\.File\]::Delete\(\$za\) \} \} catch \{\} \}; /);
    // The encoded command still fits the 8191-character command line of cmd.exe.
    assert.ok(launcher.windowsScriptCommand(s).length < 8191, agent + ': ' + launcher.windowsScriptCommand(s).length);
  }
});

test('the shared list: loader variables in any case, CA and proxy settings kept', () => {
  for (const k of ['NODE_OPTIONS', 'node_options', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_V8_COVERAGE', 'LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'OPENSSL_CONF', 'GCONV_PATH', 'BASH_ENV', 'ENV', 'PYTHONPATH']) {
    assert.ok(loaderEnv.isLoaderVar(k), k);
  }
  for (const k of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'NO_PROXY', 'PATH', 'HOME', 'ENVIRONMENT', 'NODE_ENV', 'XLD_PRELOAD']) {
    assert.equal(loaderEnv.isLoaderVar(k), false, k);
  }
  assert.deepEqual(Object.keys(loaderEnv.withoutLoaderVars({ NODE_OPTIONS: 'x', PATH: '/bin', NODE_EXTRA_CA_CERTS: 'y' })).sort(), ['NODE_EXTRA_CA_CERTS', 'PATH']);
  // zn run uses the same list.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'broker', 'run.js'), 'utf8'), /require\('\.\.\/loader-env'\)/);
});

for (const scope of ['user', 'project']) {
  test('OpenCode ' + scope + ' plugin: the hook is started without the loader variables', async (t) => {
    const f = fixture(t);
    const file = path.join(f.dir, 'zn-gate-' + scope + '.mjs');
    let src = opencode.pluginSource({ scope, nodePath: process.execPath, runnerPath: f.runner });
    // The project plugin starts `zn` from the PATH: point it at a stub zn that runs the same runner.
    if (scope === 'project') {
      const bin = path.join(f.dir, 'bin');
      fs.mkdirSync(bin);
      // On Windows the plugin starts `zn` through cmd.exe (zn is zn.cmd there), which cannot run an sh script: the stub is a .cmd.
      if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'zn.cmd'), '@echo off\r\n"' + process.execPath + '" "' + f.runner + '" %*\r\n');
      else fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(f.runner) + '\n', { mode: 0o755 });
      src = src.replace('const NODE = "zn";', 'const NODE = ' + JSON.stringify(path.join(bin, 'zn')) + ';');
    }
    assert.match(src, /env: hookEnv\(/);
    fs.writeFileSync(file, src);
    const hostile = hostileEnv(f);
    // Node.js (not Bun, which runs OpenCode) puts its own NODE_V8_COVERAGE back into every child it spawns, so it is left out here.
    delete hostile.NODE_V8_COVERAGE;
    const saved = { ...process.env };
    t.after(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });
    Object.assign(process.env, hostile);
    // The stub runner answers {} (no action): the plugin reports that as an error; what matters here is what the hook saw.
    const { ZnGate } = await import(pathToFileURL(file).href);
    const hooks = await ZnGate({ directory: f.dir });
    await assert.rejects(hooks['tool.execute.before']({ tool: 'read', sessionID: 's' }, { args: { filePath: 'README.md' } }));
    assert.equal(fs.existsSync(f.marker), false, 'a preload ran inside the hook');
    // The test runner sets variables of its own (NODE_TEST_CONTEXT ...): only the ones set here count.
    assert.deepEqual(JSON.parse(fs.readFileSync(f.seen, 'utf8')).filter((k) => k in hostile), ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']);
  });
}

test('zn-gate check warns when a loader variable is set, and only then', () => {
  const w = checkInternal.loaderWarnings({ NODE_OPTIONS: '--require x.js', PATH: '/usr/bin', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' });
  assert.equal(w.length, 1);
  assert.match(w[0], /^NODE_OPTIONS is set in this environment\./);
  assert.match(w[0], /zn hooks install <agent>/);
  assert.doesNotMatch(w[0], /NODE_EXTRA_CA_CERTS/);
  const many = checkInternal.loaderWarnings({ LD_PRELOAD: 'a', NODE_PATH: 'b' });
  assert.match(many[0], /^LD_PRELOAD, NODE_PATH are set/);
  assert.deepEqual(checkInternal.loaderWarnings({ PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.example.invalid', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' }), []);
});
