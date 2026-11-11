'use strict';
/*
 * Argument parsing of `zn team managed-config` (parseArgs and osDefault are
 * not exported, so they are checked through run() with --json).
 */
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const mc = require('../lib/team/managed-config');

const capture = (args) => {
  let out = '';
  let err = '';
  const code = mc.run(args, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
};
const files = (args) => {
  const r = capture([...args, '--json']);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out).files;
};
const withPlatform = (name, fn) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', orig); }
};

test('--agent and --os select one file', () => {
  const f = files(['--agent', 'cursor', '--os', 'linux']);
  assert.equal(f.length, 1);
  assert.equal(f[0].agent, 'cursor');
  assert.equal(f[0].os, 'linux');
});

test('--agent claude is an alias of claude-code', () => {
  const f = files(['--agent', 'claude', '--os', 'linux']);
  assert.deepEqual(f.map((x) => x.agent), ['claude-code']);
});

test('--agent all and --os all cover every agent and OS', () => {
  assert.equal(files(['--agent', 'all', '--os', 'all']).length, mc.AGENTS.length * mc.OSES.length);
});

test('--managed-hooks-only turns on the managed-only setting', () => {
  const on = files(['--agent', 'claude-code', '--os', 'linux', '--managed-hooks-only'])[0].content;
  const off = files(['--agent', 'claude-code', '--os', 'linux'])[0].content;
  assert.equal(JSON.parse(on).allowManagedHooksOnly, true);
  assert.equal(JSON.parse(off).allowManagedHooksOnly, undefined);
});

test('--exclusive-mcp adds the managed MCP file for Claude Code', () => {
  const on = files(['--agent', 'claude-code', '--os', 'linux', '--exclusive-mcp']);
  assert.equal(on.length, 2);
  assert.ok(on.some((x) => x.file.endsWith('managed-mcp.json')));
  assert.equal(files(['--agent', 'claude-code', '--os', 'linux']).length, 1);
});

test('--json prints JSON, otherwise plain text', () => {
  const j = capture(['--agent', 'codex', '--os', 'linux', '--json']);
  assert.equal(JSON.parse(j.out).schema, 1);
  const t = capture(['--agent', 'codex', '--os', 'linux']);
  assert.equal(t.code, 0);
  assert.throws(() => JSON.parse(t.out));
  assert.match(t.out, /Nothing is written/);
});

test('an unknown flag exits 2 and names the flag', () => {
  const r = capture(['--bogus']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /unknown option --bogus/);
  assert.match(r.err, /usage: zn team managed-config/);
});

test('a positional argument is an unknown option', () => {
  const r = capture(['linux']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option linux/);
});

test('a flag with no value at the end of the list needs a value', () => {
  for (const flag of ['--agent', '--os']) {
    const r = capture([flag]);
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(flag + ' needs a value'));
  }
});

test('a flag followed by another flag needs a value', () => {
  const r = capture(['--os', '--json']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--os needs a value/);
  const a = capture(['--agent', '--managed-hooks-only']);
  assert.equal(a.code, 2);
  assert.match(a.err, /--agent needs a value/);
});

test('an unknown agent or OS value is rejected', () => {
  assert.match(capture(['--agent', 'nope']).err, /unknown agent "nope"/);
  assert.match(capture(['--os', 'beos']).err, /unknown os "beos"/);
});

test('the OS default follows the platform name', () => {
  const cases = { darwin: 'macos', win32: 'windows', linux: 'linux', freebsd: 'linux', sunos: 'linux' };
  for (const [platform, os] of Object.entries(cases)) {
    const f = withPlatform(platform, () => files(['--agent', 'codex']));
    assert.deepEqual(f.map((x) => x.os), [os], platform);
  }
});

test('--os overrides the platform default', () => {
  const f = withPlatform('win32', () => files(['--agent', 'codex', '--os', 'macos']));
  assert.deepEqual(f.map((x) => x.os), ['macos']);
});
