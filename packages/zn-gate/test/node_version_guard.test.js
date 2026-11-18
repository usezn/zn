'use strict';
// An older Node.js gets one clear line and exit code 1 from bin/cli.js, not a stack trace.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function runAs(version, args, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-node-guard-'));
  const preload = path.join(dir, 'fake-node.js');
  fs.writeFileSync(preload,
    "Object.defineProperty(process.versions, 'node', { value: '" + version + "' });\n" +
    "Object.defineProperty(process, 'version', { value: 'v" + version + "' });\n");
  try {
    return spawnSync(process.execPath, ['-r', preload, CLI].concat(args), { encoding: 'utf8', timeout: 30000, input: input || '' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const version of ['12.22.12', '16.20.2', '18.20.8', '20.0.0', '20.18.3']) {
  test('Node.js ' + version + ' is refused with a clear message', () => {
    const r = runAs(version, ['--version']);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, /^zn-gate needs Node\.js 20\.19 or later, and this is Node\.js v/);
    assert.match(r.stderr, /https:\/\/nodejs\.org\//);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
    assert.strictEqual(r.stderr.trim().split('\n').length, 2);
  });
}

test('a hook started by an agent on Node.js 16 still runs and still blocks a .env read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-node-guard-hook-'));
  try {
    const env = path.join(dir, '.env');
    fs.writeFileSync(env, 'EXAMPLE_KEY=zn-check-fake-value-not-a-real-key\n');
    const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: env }, cwd: dir });
    const r = runAs('16.20.2', ['hook', 'claude-code'], event);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /"permissionDecision":\s*"deny"/);
    assert.match(r.stderr, /^Warning: zn-gate needs Node\.js 20\.19 or later/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a `zn run` command written by the hooks is not stopped by the guard on Node.js 16', () => {
  const r = runAs('16.20.2', ['run', '--', process.execPath, '-e', '']);
  assert.match(r.stderr, /^Warning: zn-gate needs Node\.js 20\.19 or later/);
  assert.doesNotMatch(r.stderr, /then run the command again\.\n[\s\S]*then run the command again/);
  assert.ok(!(r.status === 1 && r.stderr.trim().split('\n').length === 2), 'the guard stopped zn run');
});

test('MCP servers on Node.js 16 keep stdout clean', () => {
  const r = runAs('16.20.2', ['mcp']);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /^Warning: zn-gate needs Node\.js 20\.19 or later/);
});

for (const version of ['20.19.0', '20.19.6', '22.5.1']) {
  test('Node.js ' + version + ' runs normally', () => {
    const r = runAs(version, ['--version']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /needs Node\.js/);
  });
}

test('the guard is plain ES5 before the first require', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const end = src.indexOf('})();') + '})();'.length;
  assert.ok(end > 5 && end < src.indexOf('require('), 'the guard comes before the first require');
  const guard = src.slice(0, end).replace(/^#!.*\n/, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(guard.includes('process.exit(1)'));
  assert.doesNotMatch(guard, /=>|`|\b(const|let|class)\b|\.\.\./);
});
