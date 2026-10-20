'use strict';

// zn-gate check and status recognise zn deployed through managed configuration (MDM): Claude Code managed
// settings, Cursor's enterprise hooks.json, Codex's requirements.toml. Read-only; every path is injected, so no
// test reads a real system folder. The fixtures are what `zn team managed-config` prints for each OS.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { managedInstall } = require('../lib/agents/managed-policy');
const { check: realCheck, report } = require('../lib/check');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const check = (opts) => realCheck({ nodeVersion: '22.0.0', live: false, ...opts });
const FIX = path.join(__dirname, 'fixtures', 'managed-config');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const OSES = ['linux', 'macos', 'windows'];
const byId = (res, id) => res.results.find((r) => r.id === id);

/* Where each agent's managed file goes in a stand-in system root, and the injected option that points there. */
const AGENTS = {
  'claude-code': { fixture: (os) => `claude-code-${os}.json`, target: 'managed-settings.json', opt: 'claudePolicy', key: (root) => ({ managedDir: root }) },
  codex: { fixture: (os) => `codex-${os}.toml`, target: 'requirements.toml', opt: 'codexPolicy', key: (root, f) => ({ requirementsFile: path.join(root, 'requirements.toml'), managedConfigFile: path.join(root, 'none.toml'), userConfig: path.join(root, 'none-user.toml') }) },
  cursor: { fixture: (os) => `cursor-${os}.json`, target: 'hooks.json', opt: 'cursorPolicy', key: (root) => ({ hooksFile: path.join(root, 'hooks.json') }) },
};

function stage(t, id, fixture, targetName) {
  const root = tempDir(t, 'zn-managed-root-');
  const a = AGENTS[id];
  fs.copyFileSync(path.join(FIX, fixture), path.join(root, targetName || a.target));
  return { root, opts: a.key(root) };
}

function binWithZn(t) {
  const bin = tempDir(t, 'zn-managed-bin-');
  for (const f of ['zn', 'zn.cmd']) fs.writeFileSync(path.join(bin, f), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

function emptyHome(t) {
  return tempDir(t, 'zn-managed-home-');
}

for (const osName of OSES) {
  for (const id of Object.keys(AGENTS)) {
    test(`managedInstall finds zn in the ${osName} managed-config output for ${id}`, (t) => {
      const a = AGENTS[id];
      const { root, opts } = stage(t, id, a.fixture(osName));
      const m = managedInstall(id, opts);
      assert.ok(m, 'zn is recognised');
      assert.equal(m.files[0], path.join(root, a.target));
      assert.ok(m.entries.length >= 2);
    });

    test(`check: ${id} set up only through the ${osName} managed configuration is protected (managed)`, async (t) => {
      const a = AGENTS[id];
      const { root, opts } = stage(t, id, a.fixture(osName));
      const home = emptyHome(t);
      const res = await check({ home, env: { HOME: home, PATH: binWithZn(t) }, cwd: home, [a.opt]: opts });
      const r = byId(res, id);
      assert.equal(r.state, 'protected', JSON.stringify(r));
      assert.equal(r.via, 'managed');
      assert.equal(r.managed, path.join(root, a.target));
      assert.equal(r.where, r.managed);
      assert.match(r.notes[0], /installed through your organization's managed configuration/);
      assert.ok(r.notes[0].includes(r.managed));
      let out = '';
      report(res, (s) => { out += s; });
      assert.doesNotMatch(out, new RegExp(r.name + '\\s+zn is not set up'));
      assert.ok(out.includes(r.managed), 'the report names the file');
    });
  }
}

test('Claude Code: a managed-settings.d drop-in with zn is found, and the file is named', (t) => {
  const root = tempDir(t, 'zn-managed-root-');
  fs.mkdirSync(path.join(root, 'managed-settings.d'));
  fs.writeFileSync(path.join(root, 'managed-settings.json'), JSON.stringify({ permissions: { deny: [] } }));
  fs.copyFileSync(path.join(FIX, 'claude-code-linux.json'), path.join(root, 'managed-settings.d', '50-zn.json'));
  const m = managedInstall('claude-code', { managedDir: root });
  assert.deepEqual(m.files, [path.join(root, 'managed-settings.d', '50-zn.json')]);
});

test('Claude Code: the managed hooks-only fixture is recognised too', (t) => {
  const { opts } = stage(t, 'claude-code', 'claude-code-linux-managed-hooks-only.json');
  assert.ok(managedInstall('claude-code', opts));
});

test('Codex: the allow_managed_hooks_only fixture is recognised and not reported as a problem', async (t) => {
  const { opts } = stage(t, 'codex', 'codex-linux-managed-hooks-only.toml');
  const home = emptyHome(t);
  const res = await check({ home, env: { HOME: home, PATH: binWithZn(t) }, cwd: home, codexPolicy: opts });
  assert.equal(byId(res, 'codex').state, 'protected');
});

test('managed files without zn, with other hooks, or unreadable are not zn installs', (t) => {
  const root = tempDir(t, 'zn-managed-root-');
  fs.writeFileSync(path.join(root, 'managed-settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/corp/audit.sh' }] }] } }));
  assert.equal(managedInstall('claude-code', { managedDir: root }), null);
  fs.writeFileSync(path.join(root, 'managed-settings.json'), '{ not json');
  assert.equal(managedInstall('claude-code', { managedDir: root }), null);
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeReadFile: [{ command: '/opt/corp/x.sh' }] } }));
  assert.equal(managedInstall('cursor', { hooksFile: path.join(root, 'hooks.json') }), null);
  assert.equal(managedInstall('codex', { requirementsFile: path.join(root, 'missing.toml') }), null);
  assert.equal(managedInstall('opencode', {}), null);
});

test('check: without managed zn the agent is still "not set up"', async (t) => {
  const root = tempDir(t, 'zn-managed-root-');
  const home = emptyHome(t);
  const res = await check({ home, env: { HOME: home, PATH: binWithZn(t) }, cwd: home, cursorPolicy: { hooksFile: path.join(root, 'hooks.json') }, codexPolicy: { requirementsFile: path.join(root, 'r.toml') }, claudePolicy: { managedDir: root } });
  for (const id of ['claude-code', 'codex', 'cursor']) assert.equal(byId(res, id).state, 'not-set-up', id);
});

test('check: zn in the managed configuration and in the user configuration is managed, with a note that both run', async (t) => {
  const { opts } = stage(t, 'cursor', 'cursor-linux.json');
  const home = emptyHome(t);
  const env = { HOME: home, PATH: binWithZn(t) };
  getAdapter('cursor').install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const r = byId(await check({ home, env, cwd: home, cursorPolicy: opts }), 'cursor');
  assert.equal(r.managed, opts.hooksFile);
  assert.ok(r.notes.some((n) => /installed through your organization's managed configuration/.test(n)));
  assert.ok(r.notes.some((n) => /hooks run twice/.test(n)));
});

test('check: managed hooks whose command cannot start are reported, with the administrator as the fix', async (t) => {
  const root = tempDir(t, 'zn-managed-root-');
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeReadFile: [{ command: 'zn hook cursor', failClosed: true }] } }));
  const home = emptyHome(t);
  const r = byId(await check({ home, env: { HOME: home, PATH: path.join(home, 'empty-bin') }, cwd: home, cursorPolicy: { hooksFile: path.join(root, 'hooks.json') } }), 'cursor');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /no `zn` on your PATH/);
  assert.match(r.fix, /administrator/);
});

test('check never writes: the managed files are unchanged', async (t) => {
  const { root, opts } = stage(t, 'claude-code', 'claude-code-linux.json');
  const f = path.join(root, 'managed-settings.json');
  const before = fs.readFileSync(f, 'utf8');
  const home = emptyHome(t);
  await check({ home, env: { HOME: home, PATH: binWithZn(t) }, cwd: home, claudePolicy: opts });
  assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(root), ['managed-settings.json']);
});
