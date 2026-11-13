'use strict';

process.env.ZN_STATS = 'off';

// Hook settings: a config.json in the folder ZN_HOME (or HOME) names may only add protection; the settings that relax a
// check or turn on a network lookup come from the operating-system account's own .zn folder. A ConfigChange whose audit
// cannot run is not applied. The opt-in cloud sample of tool output has national ID numbers replaced.
// Fake values only; nothing is run (commands are only checked as text).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const stats = require('../lib/stats');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

// A recursive delete of the home folder, as text for the policy check only.
const HOME_DELETE = ['rm', '-rf', '~'].join(' ');

const RELAXING = {
  whenUnavailable: 'allow', failMode: 'open', blockDestructiveCommands: false, agentInstructionWrites: 'off', egressCheck: 'off',
  checkToolOutputInstructions: false, packageInstallCheck: 'online', egressAllowHosts: ['api.example.com'], packageInstallAllow: ['left-pad'],
};

function writeConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

/* An account home (what os.userInfo() would report) and a ZN_HOME folder, both empty, restored after the test. */
function homes(t) {
  const account = tempDir(t, 'zn-account-');
  const znHome = tempDir(t, 'zn-envhome-');
  const before = process.env.ZN_HOME;
  stats._useRealHome(() => account);
  process.env.ZN_HOME = znHome;
  t.after(() => {
    stats._useRealHome(null);
    if (before === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = before;
  });
  return { accountZn: path.join(account, '.zn'), znHome };
}

test('a ZN_HOME config that relaxes protection or turns on network lookups is ignored for those settings', (t) => {
  const { znHome } = homes(t);
  writeConfig(znHome, { hooks: RELAXING });
  assert.deepEqual(runner.readConfig().hooks || {}, {});
});

test('a ZN_HOME config that tightens protection applies', (t) => {
  const { znHome } = homes(t);
  const tight = { whenUnavailable: 'deny', blockDestructiveCommands: true, agentInstructionWrites: 'deny', egressCheck: 'deny',
    checkToolOutputInstructions: true, packageInstallCheck: 'offline', stopReview: 'block', replaceToolOutputOnSecret: true };
  writeConfig(znHome, { hooks: tight });
  assert.deepEqual(runner.readConfig().hooks, Object.assign({}, tight, { failMode: 'closed' }));
});

test('the account home config still relaxes, and a ZN_HOME config can only raise it again', (t) => {
  const { accountZn, znHome } = homes(t);
  writeConfig(accountZn, { hooks: RELAXING });
  assert.deepEqual(runner.readConfig().hooks, RELAXING);
  writeConfig(znHome, { hooks: { egressCheck: 'ask', agentInstructionWrites: 'deny', failMode: 'closed', checkToolOutputInstructions: true, packageInstallCheck: 'offline' } });
  const h = runner.readConfig().hooks;
  assert.equal(h.egressCheck, 'ask');
  assert.equal(h.agentInstructionWrites, 'deny');
  assert.equal(h.whenUnavailable, 'deny');
  assert.equal(h.checkToolOutputInstructions, true);
  // The account chose online: an offline value from ZN_HOME does not replace that choice.
  assert.equal(h.packageInstallCheck, 'online');
  assert.deepEqual(h.egressAllowHosts, ['api.example.com']);
});

test('a ZN_HOME list of destructive rules adds to the defaults, never narrows them', (t) => {
  const { znHome } = homes(t);
  const { DEFAULT_RULES } = require('../lib/destructive');
  writeConfig(znHome, { hooks: { blockDestructiveCommands: ['pipe_to_shell'] } });
  const v = runner.readConfig().hooks.blockDestructiveCommands;
  for (const r of DEFAULT_RULES) assert.ok(v.includes(r), r);
  assert.ok(v.includes('pipe_to_shell'));
});

test('a lower setting in ZN_HOME does not lower a stricter one in the account home', (t) => {
  const { accountZn, znHome } = homes(t);
  writeConfig(accountZn, { hooks: { egressCheck: 'deny', strict: true } });
  writeConfig(znHome, { hooks: { egressCheck: 'off', agentInstructionWrites: 'off', strict: false } });
  assert.deepEqual(runner.readConfig().hooks, { egressCheck: 'deny', strict: true });
});

test('ZN_HOME naming the account .zn folder itself reads it once, as written', (t) => {
  const { accountZn } = homes(t);
  writeConfig(accountZn, { hooks: { whenUnavailable: 'allow' } });
  process.env.ZN_HOME = accountZn;
  assert.deepEqual(runner.readConfig(), { hooks: { whenUnavailable: 'allow' } });
});

test('HOME moved to a project folder: its relaxing .zn config is ignored too', (t) => {
  homes(t);
  delete process.env.ZN_HOME;
  const fake = tempDir(t, 'zn-fakehome-');
  writeConfig(path.join(fake, '.zn'), { hooks: RELAXING });
  const keys = process.platform === 'win32' ? ['USERPROFILE', 'HOME'] : ['HOME'];
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) process.env[k] = fake;
  t.after(() => keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }));
  assert.deepEqual(runner.readConfig().hooks || {}, {});
});

test('a ZN_HOME config with blockDestructiveCommands false does not turn the destructive-command check off', async (t) => {
  const { znHome } = homes(t);
  writeConfig(znHome, { hooks: { blockDestructiveCommands: false } });
  const event = { session_id: 'abc123', cwd: process.cwd(), permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: HOME_DELETE }, tool_use_id: 'toolu_01' };
  const res = await runner.handle(adapter, event, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open' });
  assert.equal(res.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('ConfigChange: a project settings change whose audit cannot run is not applied', async (t) => {
  const home = tempDir(t, 'zn-cc-');
  const dir = tempDir(t, 'zn-hooks-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const file = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  const audit = require('../lib/audit');
  const real = audit.auditFileAt;
  audit.auditFileAt = () => { throw new Error('audit failed'); };
  t.after(() => { audit.auditFileAt = real; });
  const ev = { session_id: 'abc123', cwd: dir, permission_mode: 'default', hook_event_name: 'ConfigChange', source: 'project_settings', file_path: file };
  const res = await runner.handle(adapter, ev, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
  assert.equal(res.output.decision, 'block');
  assert.match(res.output.reason, /could not check this settings change/);
  assert.match(res.output.reason, /\.claude\/settings\.json/);
  // Local settings stay the user's own file: never blocked, also when the audit fails.
  const local = path.join(dir, '.claude', 'settings.local.json');
  fs.writeFileSync(local, '{}');
  const res2 = await runner.handle(adapter, { ...ev, source: 'local_settings', file_path: local }, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
  assert.equal(res2.output, null);
});

test('cloud sample of tool output: national ID numbers are replaced with [ID]', () => {
  const { redactForCloud } = require('../lib/hooks/cloud_output');
  const out = redactForCloud('customer DNI 48398233T, NIE X4012459V, SSN 219-09-9999 on file');
  assert.ok(!out.includes('48398233T'), out);
  assert.ok(!out.includes('X4012459V'), out);
  assert.ok(!out.includes('219-09-9999'), out);
  assert.ok(out.includes('[ID]'), out);
});

test('a stricter failMode from ZN_HOME wins over an open account failMode, whichever key is read', (t) => {
  const { accountZn, znHome } = homes(t);
  writeConfig(accountZn, { hooks: { failMode: 'open' } });
  writeConfig(znHome, { hooks: { failMode: 'closed' } });
  const h = runner.readConfig().hooks;
  assert.equal(h.failMode, 'closed');
  assert.equal(h.whenUnavailable, 'deny');
  // The same with the other key, and an account that allows unchecked actions.
  writeConfig(accountZn, { hooks: { whenUnavailable: 'allow', failMode: 'open' } });
  writeConfig(znHome, { hooks: { whenUnavailable: 'deny' } });
  const h2 = runner.readConfig().hooks;
  assert.equal(h2.failMode, 'closed');
  assert.equal(h2.whenUnavailable, 'deny');
  // A ZN_HOME that says open changes nothing.
  writeConfig(znHome, { hooks: { failMode: 'open' } });
  assert.equal(runner.readConfig().hooks.failMode, 'open');
});

test('the account config is read from <home>/.zn/config.json, and a ZN_HOME that names that folder is the account folder', (t) => {
  const { accountZn } = homes(t);
  assert.equal(stats.userHome(), accountZn);
  writeConfig(accountZn, { hooks: { whenUnavailable: 'allow', egressCheck: 'off' } });
  // Not a config.json in the home folder itself.
  fs.writeFileSync(path.join(path.dirname(accountZn), 'config.json'), JSON.stringify({ hooks: { egressCheck: 'deny' } }));
  process.env.ZN_HOME = accountZn;
  assert.deepEqual(runner.readConfig().hooks, { whenUnavailable: 'allow', egressCheck: 'off' });
  // A ZN_HOME that names another folder only tightens it.
  const other = tempDir(t, 'zn-other-');
  writeConfig(other, { hooks: { egressCheck: 'deny', whenUnavailable: 'allow' } });
  process.env.ZN_HOME = other;
  const h = runner.readConfig().hooks;
  assert.equal(h.egressCheck, 'deny');
  assert.equal(h.whenUnavailable, 'allow');
});
