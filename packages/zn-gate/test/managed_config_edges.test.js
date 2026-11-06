'use strict';
/*
 * Edge cases for `zn team managed-config` and the managed install check:
 * option handling, option combinations, and managed files in a temporary
 * folder (never a real system folder).
 */
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mc = require('../lib/team/managed-config');
const { managedInstall } = require('../lib/agents/managed-policy');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const capture = (args) => {
  let out = '';
  let err = '';
  const code = mc.run(args, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
};

test('build with no options covers every agent and OS; the output is repeatable', () => {
  const all = mc.build();
  assert.equal(all.length, mc.AGENTS.length * mc.OSES.length);
  assert.deepEqual(mc.build({}), all);
  assert.deepEqual(mc.build({ agent: 'all', os: 'all' }), all);
  assert.deepEqual(mc.build(), all);
  for (const f of all) {
    assert.equal(f.read, mc.READ_DATE);
    assert.ok(f.notes.length > 0 && f.docs.startsWith('https://'));
  }
});

test('build orders files by agent, then by OS', () => {
  const order = mc.build().map((f) => f.agent + '/' + f.os);
  const expected = [];
  for (const a of mc.AGENTS) for (const o of mc.OSES) expected.push(a + '/' + o);
  assert.deepEqual(order, expected);
});

test('build rejects an unknown agent or OS with a clear message', () => {
  assert.throws(() => mc.build({ agent: 'vim' }), /unknown agent "vim"/);
  assert.throws(() => mc.build({ os: 'beos' }), /unknown os "beos"/);
  assert.throws(() => mc.build({ agent: 'Codex' }), /unknown agent/);
  assert.throws(() => mc.build({ agent: 'codex', os: 'plan9' }), /unknown os/);
});

test('--exclusive-mcp adds a managed-mcp.json only for Claude Code', () => {
  const claude = mc.build({ agent: 'claude-code', os: 'linux', exclusiveMcp: true });
  assert.deepEqual(claude.map((f) => path.posix.basename(f.file)), ['managed-settings.json', 'managed-mcp.json']);
  assert.equal(mc.build({ agent: 'claude-code', os: 'linux' }).length, 1);
  assert.equal(mc.build({ agent: 'codex', os: 'linux', exclusiveMcp: true }).length, 1);
  assert.match(mc.build({ agent: 'codex', os: 'linux', exclusiveMcp: true })[0].notes.join(' '), /--exclusive-mcp changes nothing for Codex/);
  assert.match(mc.build({ agent: 'cursor', os: 'linux', exclusiveMcp: true })[0].notes.join(' '), /change nothing for Cursor/);
  assert.doesNotMatch(mc.build({ agent: 'cursor', os: 'linux' })[0].notes.join(' '), /change nothing/);
});

test('the Windows managed-mcp.json path uses backslashes next to the settings file', () => {
  const files = mc.build({ agent: 'claude-code', os: 'windows', exclusiveMcp: true });
  assert.equal(files[1].file, 'C:\\Program Files\\ClaudeCode\\managed-mcp.json');
  assert.ok(!files[1].file.includes('/'));
});

test('every JSON file parses, ends with one newline and holds no tab or CR', () => {
  for (const f of mc.build({ managedHooksOnly: true, exclusiveMcp: true })) {
    assert.ok(f.content.endsWith('\n') && !f.content.endsWith('\n\n'), f.file);
    assert.ok(!/[\t\r]/.test(f.content), f.file);
    if (f.format === 'json') assert.doesNotThrow(() => JSON.parse(f.content), f.file);
  }
});

test('run: help prints usage with exit 0, even next to bad options, and writes no error', () => {
  for (const args of [['--help'], ['-h'], ['--bogus', '--help']]) {
    const r = capture(args);
    assert.equal(r.code, 0);
    assert.match(r.out, /^usage: zn team managed-config/);
    assert.equal(r.err, '');
  }
});

test('run: usage errors name the problem, print usage on stderr and nothing on stdout', () => {
  const cases = [
    [['--agent'], /--agent needs a value/],
    [['--os', '--json'], /--os needs a value/],
    [['--agent', 'vim'], /unknown agent "vim"/],
    [['--os', 'beos'], /unknown os "beos"/],
    [['--bogus'], /unknown option --bogus/],
    [['codex'], /unknown option codex/],
    [[''], /unknown option /],
  ];
  for (const [args, re] of cases) {
    const r = capture(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, re);
    assert.match(r.err, /usage: zn team managed-config/);
    assert.equal(r.out, '');
  }
});

test('run: "claude" is accepted as Claude Code, and the last repeated option wins', () => {
  const r = capture(['--agent', 'claude', '--os', 'linux', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out).files.map((f) => f.agent), ['claude-code']);
  const twice = capture(['--agent', 'codex', '--agent', 'cursor', '--os', 'linux', '--os', 'macos', '--json']);
  const files = JSON.parse(twice.out).files;
  assert.deepEqual(files.map((f) => f.agent + '/' + f.os), ['cursor/macos']);
});

test('run: the text output shows the file, source and notes for each entry', () => {
  const r = capture(['--agent', 'codex', '--os', 'linux']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Nothing is written/);
  assert.match(r.out, /=== Codex on Linux ===\nFile: \/etc\/codex\/requirements\.toml\n/);
  assert.match(r.out, /Format read from https:\/\/\S+ on 2026-10-19/);
  assert.match(r.out, /\n- If this file already exists/);
  assert.ok(r.out.endsWith('\n'));
});

test('the command ignores HOME: the same output and nothing written, with a temporary HOME', (t) => {
  const home = tempDir(t, 'zn-mc-home-');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
  const before = fs.readdirSync(home, { recursive: true }).sort();
  const run = (h) => spawnSync(process.execPath, [CLI, 'team', 'managed-config', '--agent', 'all', '--os', 'linux', '--json'], {
    cwd: home, encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, ZN_STATS: 'off' },
  });
  const a = run(home);
  const b = run(path.join(home, 'missing'));
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), before);
});

/* Write the printed files into a stand-in system folder and ask the managed install check about them. */
function install(t, agent, mutate) {
  const root = tempDir(t, 'zn-mc-install-');
  const f = mc.build({ agent, os: 'linux' })[0];
  const target = path.join(root, path.basename(f.file));
  fs.writeFileSync(target, mutate ? mutate(f.content) : f.content);
  const opts = agent === 'claude-code' ? { managedDir: root }
    : agent === 'codex' ? { requirementsFile: target }
      : { hooksFile: target };
  return { root, target, opts };
}

test('managed install: the printed file is recognised for each agent', (t) => {
  for (const agent of mc.AGENTS) {
    const { target, opts } = install(t, agent);
    const m = managedInstall(agent, opts);
    assert.ok(m, agent);
    assert.deepEqual(m.files, [target]);
    assert.ok(m.entries.length >= 2, agent);
  }
});

test('managed install: empty, malformed or hook-less files are not zn', (t) => {
  const cases = {
    empty: () => '',
    blank: () => '\n  \n',
    malformed: () => '{ "hooks": ',
    notAnObject: () => '[1, 2, 3]',
    noHooks: () => '{}',
    hooksNotObject: () => '{ "hooks": "zn hook x" }',
  };
  for (const [name, mutate] of Object.entries(cases)) {
    for (const agent of ['claude-code', 'cursor']) {
      const { opts } = install(t, agent, mutate);
      assert.equal(managedInstall(agent, opts), null, agent + ' ' + name);
    }
  }
  const toml = install(t, 'codex', () => 'allow_managed_hooks_only = [');
  assert.equal(managedInstall('codex', toml.opts), null);
  const emptyToml = install(t, 'codex', () => '');
  assert.equal(managedInstall('codex', emptyToml.opts), null);
});

test('managed install: a missing file, a folder in its place or an unknown agent finds nothing', (t) => {
  const root = tempDir(t, 'zn-mc-missing-');
  assert.equal(managedInstall('claude-code', { managedDir: path.join(root, 'none') }), null);
  assert.equal(managedInstall('cursor', { hooksFile: path.join(root, 'hooks.json') }), null);
  assert.equal(managedInstall('codex', { requirementsFile: path.join(root, 'requirements.toml') }), null);
  fs.mkdirSync(path.join(root, 'hooks.json'));
  assert.equal(managedInstall('cursor', { hooksFile: path.join(root, 'hooks.json') }), null);
  assert.equal(managedInstall('vim', { managedDir: root }), null);
});

test('managed install: hooks that are not zn\'s are not counted', (t) => {
  const other = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'other-tool check' }] }] } });
  const { opts } = install(t, 'claude-code', () => other);
  assert.equal(managedInstall('claude-code', opts), null);
});

test('managed install: Claude Code drop-ins are read in name order after the main file', (t) => {
  const root = tempDir(t, 'zn-mc-dropin-');
  const content = mc.build({ agent: 'claude-code', os: 'linux' })[0].content;
  const d = path.join(root, 'managed-settings.d');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, '60-zn.json'), content);
  fs.writeFileSync(path.join(d, '50-zn.json'), content);
  fs.writeFileSync(path.join(d, '70-broken.json'), '{ nope');
  fs.writeFileSync(path.join(d, '40-notes.txt'), content);
  fs.writeFileSync(path.join(root, 'managed-settings.json'), content);
  const m = managedInstall('claude-code', { managedDir: root });
  assert.deepEqual(m.files, [path.join(root, 'managed-settings.json'), path.join(d, '50-zn.json'), path.join(d, '60-zn.json')]);
});

test('managed install: a Claude Code drop-in alone is enough', (t) => {
  const root = tempDir(t, 'zn-mc-dropin-only-');
  fs.mkdirSync(path.join(root, 'managed-settings.d'));
  const f = path.join(root, 'managed-settings.d', '50-zn.json');
  fs.writeFileSync(f, mc.build({ agent: 'claude-code', os: 'linux' })[0].content);
  assert.deepEqual(managedInstall('claude-code', { managedDir: root }).files, [f]);
});
