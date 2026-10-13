#!/usr/bin/env node
'use strict';

/**
 * Tests for plugins/zn-gate/scripts/zn-launch.js against a fake zn-gate
 * package installed in a temporary npm-style prefix. No network, no
 * dependencies.
 *
 *   node plugins/tools/test-launch.js
 *
 * The launcher reads ~/.zn/config.json from the account's real home
 * directory (not $HOME). Tests that need a config run a copy of the launcher
 * whose homeDir() returns a temporary directory instead.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LAUNCHER = path.resolve(__dirname, '..', 'zn-gate', 'scripts', 'zn-launch.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-launch-')));
const WIN = process.platform === 'win32';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// npm global layout: <prefix>/bin/zn-gate -> <prefix>/lib/node_modules/zn-gate (Linux, macOS),
// <prefix>\zn-gate.cmd next to <prefix>\node_modules\zn-gate (Windows).
const prefix = path.join(tmp, 'prefix');
const binDir = WIN ? prefix : path.join(prefix, 'bin');
const pkgDir = WIN ? path.join(prefix, 'node_modules', 'zn-gate') : path.join(prefix, 'lib', 'node_modules', 'zn-gate');

const SOURCES = {
  'package.json': JSON.stringify({ name: 'zn-gate', version: '9.9.9' }),
  'bin/cli.js': '#!/usr/bin/env node\n',
  // The runner uses a relative require, a bundled dependency, JSON and a dynamic import of an ES module.
  'lib/hooks/runner.js': [
    "const policy = require('./policy');",
    "const dep = require('dep');",
    "const data = require('../data.json');",
    'exports.main = async (a) => {',
    "  let s = ''; for await (const c of process.stdin) s += c;",
    "  if (s.includes('throw')) throw new Error('runner exploded');",
    "  if (s.includes('echo-exit1')) { process.stdout.write(s); process.exit(1); }",
    "  if (s.includes('reject')) { Promise.reject(new Error('stray rejection')); await new Promise((r) => setTimeout(r, 50)); }",
    "  const esm = await import('esm-dep');",
    "  process.stdout.write(['ran', a[0], policy.name, dep.name, data.name, esm.name, s.trim()].join(' '));",
    '};',
    '',
  ].join('\n'),
  'lib/hooks/policy.js': "exports.name = 'policy';\n",
  'lib/data.json': '{"name": "data"}\n',
  'lib/broker/mcp.js': "exports.startSecretsMcp = () => process.stdout.write('mcp');\n",
  'node_modules/dep/package.json': '{"name": "dep", "main": "main.js"}\n',
  'node_modules/dep/main.js': "exports.name = 'dep';\n",
  'node_modules/esm-dep/package.json': '{"name": "esm-dep", "type": "module", "exports": "./index.js"}\n',
  'node_modules/esm-dep/index.js': "export const name = 'esm';\n",
};

function installPackage() {
  fs.rmSync(prefix, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(SOURCES)) write(path.join(pkgDir, ...rel.split('/')), text);
  if (WIN) write(path.join(binDir, 'zn-gate.cmd'), '@echo off\r\n');
  else {
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(pkgDir, 'bin', 'cli.js'), path.join(binDir, 'zn-gate'));
  }
}
installPackage();
const files = {};
for (const rel of Object.keys(SOURCES)) files[rel] = sha(path.join(pkgDir, ...rel.split('/')));

// Plugin copies with their own lock file: one as shipped, one whose home directory is a temporary one.
const home = path.join(tmp, 'home');
const pluginReal = path.join(tmp, 'plugin-real', 'scripts');
const pluginTest = path.join(tmp, 'plugin-test', 'scripts');
const source = fs.readFileSync(LAUNCHER, 'utf8');
const patched = source.replace(/function homeDir\(\) \{/, 'function homeDir() { return ' + JSON.stringify(home) + ';');
assert.notStrictEqual(patched, source, 'homeDir() not found in the launcher');
write(path.join(pluginReal, 'zn-launch.js'), source);
write(path.join(pluginTest, 'zn-launch.js'), patched);
function setLock(lock) {
  for (const d of [pluginReal, pluginTest]) write(path.join(d, 'zn-gate.lock.json'), JSON.stringify(lock));
}
setLock({ package: 'zn-gate', version: '9.9.9', files });
function setConfig(cfg) { write(path.join(home, '.zn', 'config.json'), JSON.stringify(cfg)); }

function run(args, input, opts = {}) {
  return spawnSync(process.execPath, [path.join(opts.real ? pluginReal : pluginTest, 'zn-launch.js'), ...args], {
    input: input === undefined ? '{"hook_event_name":"PreToolUse"}' : input,
    encoding: 'utf8',
    env: { PATH: opts.path || binDir, HOME: opts.home || home, USERPROFILE: opts.home || home, SystemRoot: process.env.SystemRoot || '', ...(opts.env || {}) },
  });
}

let n = 0;
function test(name, fn) { fn(); n++; process.stdout.write('ok ' + n + ' - ' + name + '\n'); }
function refused(r, re) {
  assert.strictEqual(r.status, 2, 'expected exit 2, got ' + r.status + ': ' + r.stderr + r.stdout);
  if (re) assert.match(r.stderr, re);
}

try {
  test('verified package runs the runner from memory (relative, bundled, JSON and ESM imports)', () => {
    setConfig({});
    const r = run(['hook', 'codex'], '{"x":1}');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'ran codex policy dep data esm {"x":1}');
  });

  test('secrets-mcp starts the MCP server of the verified package', () => {
    const r = run(['secrets-mcp']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'mcp');
  });

  test('missing package fails closed with exit 2', () => {
    refused(run(['hook', 'claude-code'], undefined, { path: path.join(tmp, 'empty-bin') }), /not installed/);
  });

  test('cursor also gets a deny answer on stdout', () => {
    const r = run(['hook', 'cursor'], undefined, { path: path.join(tmp, 'empty-bin') });
    refused(r);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
  });

  test('whenUnavailable allow in ~/.zn/config.json lets the event pass', () => {
    setConfig({ hooks: { whenUnavailable: 'allow' } });
    const r = run(['hook', 'claude-code'], undefined, { path: path.join(tmp, 'empty-bin') });
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /passed through/);
    setConfig({});
  });

  test('$HOME does not choose the config file (redirected HOME with whenUnavailable allow is ignored)', () => {
    const fake = path.join(tmp, 'fake-home');
    write(path.join(fake, '.zn', 'config.json'), JSON.stringify({ hooks: { whenUnavailable: 'allow' } }));
    const r = run(['hook', 'claude-code'], undefined, { real: true, home: fake, path: path.join(tmp, 'empty-bin') });
    if (r.status === 0 && /passed through/.test(r.stderr)) {
      // The real home of the account running the tests allows it; nothing to conclude.
      process.stdout.write('# skipped: the real ~/.zn/config.json of this account sets whenUnavailable allow\n');
      return;
    }
    refused(r, /not installed/);
  });

  test('another version is refused', () => {
    setLock({ package: 'zn-gate', version: '9.9.8', files });
    refused(run(['hook', 'claude-code']), /needs zn-gate 9\.9\.8/);
    setLock({ package: 'zn-gate', version: '9.9.9', files });
  });

  test('a changed locked file is refused', () => {
    fs.appendFileSync(path.join(pkgDir, 'lib', 'hooks', 'policy.js'), '// changed\n');
    refused(run(['hook', 'claude-code']), /lib\/hooks\/policy\.js was changed/);
    assert.notStrictEqual(run(['secrets-mcp']).status, 0);
    installPackage();
  });

  test('an extra extensionless file next to a locked module is refused (it would load first)', () => {
    write(path.join(pkgDir, 'lib', 'hooks', 'policy'), "process.stdout.write('PLANTED CODE RAN'); process.exit(0);\n");
    const r = run(['hook', 'claude-code']);
    refused(r, /unexpected file lib\/hooks\/policy/);
    assert.ok(!r.stdout.includes('PLANTED'));
    const c = run(['check', 'claude-code']);
    assert.match(JSON.parse(c.stdout).systemMessage, /unexpected file lib\/hooks\/policy/);
    installPackage();
  });

  test('a planted node_modules directory is refused', () => {
    write(path.join(pkgDir, 'lib', 'node_modules', 'dep', 'index.js'), "exports.name = 'planted';\n");
    refused(run(['hook', 'claude-code']), /unexpected directory lib\/node_modules/);
    installPackage();
  });

  test('a symbolic link inside the package is refused', () => {
    try {
      fs.symlinkSync(path.join(pkgDir, 'lib', 'data.json'), path.join(pkgDir, 'lib', 'link.json'));
    } catch (err) {
      process.stdout.write('# skipped: cannot create symbolic links here (' + err.code + ')\n');
      return;
    }
    refused(run(['hook', 'claude-code']), /link\.json is a symbolic link/);
    installPackage();
  });

  test('a missing locked file is refused', () => {
    fs.rmSync(path.join(pkgDir, 'lib', 'data.json'));
    refused(run(['hook', 'claude-code']), /lib\/data\.json is missing/);
    installPackage();
  });

  test('an exception in the runner fails closed', () => {
    refused(run(['hook', 'claude-code'], '{"throw":1}'), /runner exploded/);
  });

  test('an unhandled rejection fails closed', () => {
    refused(run(['hook', 'claude-code'], '{"reject":1}'), /stray rejection/);
  });

  test('a module that cannot load fails closed', () => {
    const bad = { ...SOURCES, 'lib/hooks/runner.js': 'x(\n' };
    write(path.join(pkgDir, 'lib', 'hooks', 'runner.js'), bad['lib/hooks/runner.js']);
    setLock({ package: 'zn-gate', version: '9.9.9', files: { ...files, 'lib/hooks/runner.js': sha(path.join(pkgDir, 'lib', 'hooks', 'runner.js')) } });
    refused(run(['hook', 'claude-code']), /failed to load/);
    setLock({ package: 'zn-gate', version: '9.9.9', files });
    installPackage();
  });

  test('an exit code other than 0 or 2 from zn-gate becomes 2', () => {
    for (const body of ['process.exit(1);', 'process.exitCode = 1;', 'process.exit(3);']) {
      write(path.join(pkgDir, 'lib', 'hooks', 'runner.js'), 'exports.main = async () => { ' + body + ' };\n');
      setLock({ package: 'zn-gate', version: '9.9.9', files: { ...files, 'lib/hooks/runner.js': sha(path.join(pkgDir, 'lib', 'hooks', 'runner.js')) } });
      refused(run(['hook', 'claude-code'], '{}'), /ended with exit code/);
      const c = run(['hook', 'cursor'], '{}');
      refused(c);
      assert.strictEqual(JSON.parse(c.stdout).permission, 'deny');
    }
    setConfig({ hooks: { whenUnavailable: 'allow' } });
    const passed = run(['hook', 'claude-code'], '{}');
    assert.strictEqual(passed.status, 0);
    assert.match(passed.stderr, /passed through/);
    setConfig({});
    setLock({ package: 'zn-gate', version: '9.9.9', files });
    installPackage();
  });

  // A refused tool output must be replaced, not just answered with exit 2:
  // Claude Code and Codex pass the original output on to the model on exit 2.
  // AWS's documented example key, allowlisted in .gitleaks.toml.
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';
  const postEvents = {
    'claude-code': (extra) => JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat x' }, tool_response: { stdout: 'key ' + SECRET + extra, stderr: '', interrupted: false } }),
    codex: (extra) => JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat x' }, tool_response: 'key ' + SECRET + extra }),
    cursor: (extra) => JSON.stringify({ hook_event_name: 'postToolUse', tool_name: 'MCP:fetch', tool_input: {}, tool_output: JSON.stringify({ content: [{ type: 'text', text: 'key ' + SECRET + extra }] }) }),
  };
  function checkWithheld(agent, r) {
    assert.ok(!r.stdout.includes(SECRET), agent + ': the secret reached stdout: ' + r.stdout);
    assert.strictEqual(r.status, 0, agent + ': ' + r.stderr);
    const out = JSON.parse(r.stdout);
    if (agent === 'claude-code') {
      assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
      assert.strictEqual(out.hookSpecificOutput.updatedToolOutput.stdout, '[zn plugin: output withheld because zn could not check it]');
      assert.strictEqual(out.hookSpecificOutput.updatedToolOutput.interrupted, false);
      assert.match(out.hookSpecificOutput.additionalContext, /zn plugin:/);
    } else if (agent === 'codex') {
      assert.strictEqual(out.decision, 'block');
      assert.match(out.reason, /output withheld/);
    } else {
      assert.strictEqual(out.updated_mcp_tool_output.content[0].text, '[zn plugin: output withheld because zn could not check it]');
    }
  }
  const tampers = {
    'changed file': () => fs.appendFileSync(path.join(pkgDir, 'lib', 'hooks', 'policy.js'), '// changed\n'),
    'extra file': () => write(path.join(pkgDir, 'lib', 'hooks', 'policy'), 'process.exit(0);\n'),
    'missing package': null,
    'load failure': () => relock('lib/hooks/runner.js', 'x(\n'),
    'exit 1 after echoing the event': 'echo-exit1',
    'exception in main': 'throw',
    'unhandled rejection': 'reject',
  };
  function relock(rel, text) {
    write(path.join(pkgDir, ...rel.split('/')), text);
    setLock({ package: 'zn-gate', version: '9.9.9', files: { ...files, [rel]: sha(path.join(pkgDir, ...rel.split('/'))) } });
  }
  for (const [name, tamper] of Object.entries(tampers)) {
    test('PostToolUse output is withheld, not leaked, on: ' + name, () => {
      for (const agent of Object.keys(postEvents)) {
        installPackage();
        setLock({ package: 'zn-gate', version: '9.9.9', files });
        let extra = '';
        let opts = {};
        if (typeof tamper === 'function') tamper();
        else if (typeof tamper === 'string') extra = ' ' + tamper;
        else opts = { path: path.join(tmp, 'empty-bin') };
        checkWithheld(agent, run(['hook', agent], postEvents[agent](extra), opts));
      }
      installPackage();
      setLock({ package: 'zn-gate', version: '9.9.9', files });
    });
  }

  test('a refused PreToolUse or prompt is still blocked with exit 2', () => {
    fs.appendFileSync(path.join(pkgDir, 'lib', 'hooks', 'policy.js'), '// changed\n');
    refused(run(['hook', 'claude-code'], JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } })));
    refused(run(['hook', 'claude-code'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })));
    refused(run(['hook', 'codex'], JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })));
    const c = run(['hook', 'cursor'], JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'ls' }));
    refused(c);
    assert.strictEqual(JSON.parse(c.stdout).permission, 'deny');
    installPackage();
  });

  test('a successful answer from zn-gate is passed through unchanged', () => {
    const r = run(['hook', 'claude-code'], postEvents['claude-code'](''));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ran claude-code policy dep data esm /);
  });

  test('NODE_OPTIONS and NODE_PATH are not passed on to what zn-gate starts', () => {
    const extra = { 'lib/hooks/runner.js': "exports.main = async () => process.stdout.write(JSON.stringify([process.env.NODE_OPTIONS || null, process.env.NODE_PATH || null]));\n" };
    write(path.join(pkgDir, 'lib', 'hooks', 'runner.js'), extra['lib/hooks/runner.js']);
    setLock({ package: 'zn-gate', version: '9.9.9', files: { ...files, 'lib/hooks/runner.js': sha(path.join(pkgDir, 'lib', 'hooks', 'runner.js')) } });
    const r = run(['hook', 'claude-code'], '{}', { env: { NODE_OPTIONS: '--max-old-space-size=200', NODE_PATH: tmp } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), [null, null]);
    setLock({ package: 'zn-gate', version: '9.9.9', files });
    installPackage();
  });

  test('every candidate is tried: an old copy first on PATH does not hide the pinned one', () => {
    const oldBin = path.join(tmp, 'old', WIN ? '' : 'bin');
    const oldPkg = WIN ? path.join(tmp, 'old', 'node_modules', 'zn-gate') : path.join(tmp, 'old', 'lib', 'node_modules', 'zn-gate');
    write(path.join(oldPkg, 'package.json'), JSON.stringify({ name: 'zn-gate', version: '1.0.0' }));
    write(path.join(oldPkg, 'bin', 'cli.js'), '');
    if (WIN) write(path.join(oldBin, 'zn-gate.cmd'), '@echo off\r\n');
    else { fs.mkdirSync(oldBin, { recursive: true }); fs.symlinkSync(path.join(oldPkg, 'bin', 'cli.js'), path.join(oldBin, 'zn-gate')); }
    const r = run(['hook', 'codex'], '{}', { path: oldBin + path.delimiter + binDir });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ran codex/);
  });

  test('a lock without digests is refused', () => {
    setLock({ package: 'zn-gate', version: '9.9.9', files: {} });
    refused(run(['hook', 'claude-code']), /development build/);
    setLock({ package: 'zn-gate', version: '9.9.9', files });
  });

  test('check is silent when everything is in place and never blocks', () => {
    const ok = run(['check', 'claude-code']);
    assert.strictEqual(ok.status, 0);
    assert.strictEqual(ok.stdout, '');
    const missing = run(['check', 'claude-code'], undefined, { path: path.join(tmp, 'empty-bin') });
    assert.strictEqual(missing.status, 0);
    assert.match(JSON.parse(missing.stdout).systemMessage, /not installed/);
  });

  test('check warns about hooks also installed in settings.json', () => {
    write(path.join(tmp, 'claude-config', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"/usr/bin/node" "/x/lib/hooks/runner.js" claude-code' }] }] },
    }));
    const r = run(['check', 'claude-code'], undefined, { env: { CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') } });
    assert.match(JSON.parse(r.stdout).systemMessage, /zn hooks uninstall claude-code/);
  });

  test('unknown agent is a usage error', () => {
    assert.strictEqual(run(['hook', 'other']).status, 1);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.stdout.write('1..' + n + '\n');
