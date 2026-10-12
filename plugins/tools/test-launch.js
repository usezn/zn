#!/usr/bin/env node
'use strict';

/**
 * Tests for plugins/zn-gate/scripts/zn-launch.js against a fake zn-gate
 * package in a temporary home directory. No network, no dependencies.
 *
 *   node plugins/tools/test-launch.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LAUNCHER = path.resolve(__dirname, '..', 'zn-gate', 'scripts', 'zn-launch.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-launch-'));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Fake zn-gate package: the runner echoes the agent id and the event.
const pkgDir = path.join(tmp, 'pkg', 'zn-gate');
write(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'zn-gate', version: '9.9.9' }));
write(path.join(pkgDir, 'lib', 'hooks', 'runner.js'),
  "exports.main = async (a) => { let s = ''; for await (const c of process.stdin) s += c; process.stdout.write('ran ' + a[0] + ' ' + s.trim()); };\n");
write(path.join(pkgDir, 'lib', 'broker', 'mcp.js'), "exports.startSecretsMcp = () => process.stdout.write('mcp');\n");

// Plugin copy with its own lock file.
const plugin = path.join(tmp, 'plugin', 'scripts');
fs.mkdirSync(plugin, { recursive: true });
fs.copyFileSync(LAUNCHER, path.join(plugin, 'zn-launch.js'));
const files = {};
for (const rel of ['package.json', 'lib/hooks/runner.js', 'lib/broker/mcp.js']) files[rel] = sha(path.join(pkgDir, ...rel.split('/')));
function setLock(lock) { write(path.join(plugin, 'zn-gate.lock.json'), JSON.stringify(lock)); }
setLock({ package: 'zn-gate', version: '9.9.9', files });

const home = path.join(tmp, 'home');
function setConfig(cfg) { write(path.join(home, '.zn', 'config.json'), JSON.stringify(cfg)); }

function run(args, input) {
  return spawnSync(process.execPath, [path.join(plugin, 'zn-launch.js'), ...args], {
    input: input || '{"hook_event_name":"PreToolUse"}',
    encoding: 'utf8',
    env: { PATH: path.join(tmp, 'empty-bin'), HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot || '' },
  });
}

let n = 0;
function test(name, fn) { fn(); n++; process.stdout.write('ok ' + n + ' - ' + name + '\n'); }

try {
  test('missing package fails closed with exit 2', () => {
    setConfig({});
    const r = run(['hook', 'claude-code']);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /not installed/);
  });

  test('cursor gets a deny answer on stdout too', () => {
    const r = run(['hook', 'cursor']);
    assert.strictEqual(r.status, 2);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
  });

  test('whenUnavailable allow lets the event pass', () => {
    setConfig({ hooks: { whenUnavailable: 'allow' } });
    const r = run(['hook', 'claude-code']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /passed through/);
  });

  test('verified package runs the hook runner with the event', () => {
    setConfig({ plugin: { packageDir: pkgDir } });
    const r = run(['hook', 'codex'], '{"x":1}');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'ran codex {"x":1}');
    assert.ok(fs.existsSync(path.join(home, '.zn', 'plugin-verified.json')), 'verification record written');
    const again = run(['hook', 'codex'], '{"x":2}');
    assert.strictEqual(again.stdout, 'ran codex {"x":2}');
  });

  test('secrets-mcp starts the MCP server of the verified package', () => {
    const r = run(['secrets-mcp']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'mcp');
  });

  test('another version is refused', () => {
    setLock({ package: 'zn-gate', version: '9.9.8', files });
    const r = run(['hook', 'claude-code']);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /needs zn-gate 9\.9\.8/);
    setLock({ package: 'zn-gate', version: '9.9.9', files });
  });

  test('a changed file is refused', () => {
    const runner = path.join(pkgDir, 'lib', 'hooks', 'runner.js');
    const orig = fs.readFileSync(runner);
    fs.appendFileSync(runner, '// changed\n');
    const r = run(['hook', 'claude-code']);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /lib\/hooks\/runner\.js was changed/);
    const m = run(['secrets-mcp']);
    assert.notStrictEqual(m.status, 0);
    assert.strictEqual(m.stdout, '');
    fs.writeFileSync(runner, orig);
  });

  test('a lock without digests is refused unless allowUnverified', () => {
    setLock({ package: 'zn-gate', version: '9.9.9', files: {} });
    assert.strictEqual(run(['hook', 'claude-code']).status, 2);
    setConfig({ plugin: { packageDir: pkgDir, allowUnverified: true } });
    assert.strictEqual(run(['hook', 'claude-code']).status, 0);
    const c = run(['check', 'claude-code']);
    assert.match(JSON.parse(c.stdout).systemMessage, /without file verification/);
    setLock({ package: 'zn-gate', version: '9.9.9', files });
  });

  test('check is silent when everything is in place and never blocks', () => {
    setConfig({ plugin: { packageDir: pkgDir } });
    const ok = run(['check', 'claude-code']);
    assert.strictEqual(ok.status, 0);
    assert.strictEqual(ok.stdout, '');
    setConfig({});
    const missing = run(['check', 'claude-code']);
    assert.strictEqual(missing.status, 0);
    assert.match(JSON.parse(missing.stdout).systemMessage, /not installed/);
  });

  test('check warns about hooks also installed in settings.json', () => {
    setConfig({ plugin: { packageDir: pkgDir } });
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"/usr/bin/node" "/x/lib/hooks/runner.js" claude-code' }] }] },
    }));
    const r = run(['check', 'claude-code']);
    assert.match(JSON.parse(r.stdout).systemMessage, /zn hooks uninstall claude-code/);
  });

  test('unknown agent is a usage error', () => {
    assert.strictEqual(run(['hook', 'other']).status, 1);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.stdout.write('1..' + n + '\n');
