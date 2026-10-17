'use strict';

// Codex settings that turn zn's hooks off with no sign in Codex: the organization's requirements.toml,
// its managed_config.toml and the user's own config.toml. zn says it in `zn hooks install codex` and in check.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { codexPolicyWarnings, _internal } = require('../lib/agents/managed-policy');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function setup(t, { requirements, managed, user } = {}) {
  const root = tempDir(t, 'zn-codex-policy-');
  const home = path.join(root, '.codex');
  fs.mkdirSync(home, { recursive: true });
  const requirementsFile = path.join(root, 'requirements.toml');
  const managedConfigFile = path.join(root, 'managed_config.toml');
  if (requirements !== undefined) fs.writeFileSync(requirementsFile, requirements);
  if (managed !== undefined) fs.writeFileSync(managedConfigFile, managed);
  if (user !== undefined) fs.writeFileSync(path.join(home, 'config.toml'), user);
  return { codexHome: home, requirementsFile, managedConfigFile, env: {} };
}

test('nothing set: no warning', (t) => {
  assert.deepEqual(codexPolicyWarnings(setup(t)), []);
  assert.deepEqual(codexPolicyWarnings(setup(t, { user: 'model = "o4"\n[features]\nhooks = true\n' })), []);
});

test('requirements that turn hooks off, or run only managed hooks', (t) => {
  const off = codexPolicyWarnings(setup(t, { requirements: '[features]\nhooks = false\n' }));
  assert.equal(off.length, 1);
  assert.match(off[0], /requirements .* turn hooks off \(\[features\] hooks = false\), so zn's hooks do not run/);
  const only = codexPolicyWarnings(setup(t, { requirements: 'allow_managed_hooks_only = true\n' }));
  assert.match(only[0], /run only the hooks they manage \(allow_managed_hooks_only\), so the zn hooks you install do not run/);
  // zn deployed as one of the managed hooks, in the layout Codex documents: nothing to say.
  const managedHook = (cmd) => 'allow_managed_hooks_only = true\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ' + JSON.stringify(cmd) + '\n';
  assert.deepEqual(codexPolicyWarnings(setup(t, { requirements: managedHook('zn hook codex') })), []);
  assert.deepEqual(codexPolicyWarnings(setup(t, { requirements: managedHook('"/usr/bin/node" "/opt/zn-gate/lib/hooks/runner.js" codex') })), []);
  // Another command that only mentions codex is not zn.
  assert.match(codexPolicyWarnings(setup(t, { requirements: managedHook('audit-hook codex-log') }))[0], /allow_managed_hooks_only/);
});

test('the managed configuration and the user config.toml', (t) => {
  assert.match(codexPolicyWarnings(setup(t, { managed: '[features]\nhooks = false\n' }))[0], /managed configuration .* turns hooks off .* at every start/);
  assert.match(codexPolicyWarnings(setup(t, { user: '[features]\nhooks = false\n' }))[0], /config\.toml turns hooks off .* Remove that line, or set it to true/);
  // The older name of the feature.
  assert.match(codexPolicyWarnings(setup(t, { user: '[features]\ncodex_hooks = false\n' }))[0], /turns hooks off/);
  // A managed configuration that sets hooks on is applied again at every start, over the user's own setting.
  assert.deepEqual(codexPolicyWarnings(setup(t, { managed: '[features]\nhooks = true\n', user: '[features]\nhooks = false\n' })), []);
  // Requirements that force hooks on win over the user's own setting.
  assert.deepEqual(codexPolicyWarnings(setup(t, { requirements: '[features]\nhooks = true\n', user: '[features]\nhooks = false\n' })), []);
});

test('a requirements file zn cannot read is said, not ignored', (t) => {
  const w = codexPolicyWarnings(setup(t, { requirements: '[features\nhooks = = false\n' }));
  assert.match(w[0], /could not read the Codex requirements .* \(invalid TOML\)/);
});

test('the system paths of the requirements and managed configuration', () => {
  assert.equal(_internal.codexRequirementsFile('linux', {}), '/etc/codex/requirements.toml');
  assert.equal(_internal.codexRequirementsFile('darwin', {}), '/etc/codex/requirements.toml');
  assert.equal(_internal.codexRequirementsFile('win32', { ProgramData: 'D:\\PD' }), path.join('D:\\PD', 'OpenAI', 'Codex', 'requirements.toml'));
  assert.equal(_internal.codexManagedConfigFile('linux', '/h/.codex'), '/etc/codex/managed_config.toml');
  assert.equal(_internal.codexManagedConfigFile('win32', 'C:\\Users\\x\\.codex'), path.join('C:\\Users\\x\\.codex', 'managed_config.toml'));
});

test('zn hooks install codex and zn-gate check say it when the user config.toml turns hooks off', async (t) => {
  const home = tempDir(t, 'zn-codex-home-');
  const env = { HOME: home, PATH: path.dirname(process.execPath) };
  const p = setup(t, { requirements: '' });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[features]\nhooks = false\n');
  const report = getAdapter('codex').install({
    scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false,
    codexRequirementsFile: p.requirementsFile, codexManagedConfigFile: p.managedConfigFile,
  });
  assert.ok(report.warnings.some((w) => /turns hooks off \(\[features\] hooks = false\)/.test(w)), JSON.stringify(report.warnings));
  const { check } = require('../lib/check');
  const r = (await check({ home, env, cwd: home, live: false, codexPolicy: { requirementsFile: p.requirementsFile, managedConfigFile: p.managedConfigFile } })).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /turns hooks off/);
  assert.match(r.fix, /change that Codex setting/);
});

test('zn-gate check notes a requirements file it cannot read, without calling Codex unprotected', async (t) => {
  const home = tempDir(t, 'zn-codex-home2-');
  const env = { HOME: home, PATH: path.dirname(process.execPath) };
  const p = setup(t, { requirements: '[features\nbroken = = 1\n' });
  getAdapter('codex').install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false, codexRequirementsFile: p.requirementsFile, codexManagedConfigFile: p.managedConfigFile });
  const { check } = require('../lib/check');
  const r = (await check({ home, env, cwd: home, live: false, codexPolicy: { requirementsFile: p.requirementsFile, managedConfigFile: p.managedConfigFile } })).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'protected');
  assert.ok(r.notes.some((n) => /could not read the Codex requirements/.test(n)), JSON.stringify(r.notes));
});
