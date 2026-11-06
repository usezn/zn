'use strict';

process.env.ZN_STATS = 'off';
delete process.env.ZN_PACKAGE_CHECK;

// Package install check: no request after a deny, request options, the lookup limit, look-alike names and settings files of another registry. No network: every fetcher here is fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const pc = require('../lib/package-check');
const reg = require('../lib/package-registry');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const CWD = path.join(path.sep, 'work', 'proj');

test('a command that ends in a deny makes no registry request', async (t) => {
  const home = tempDir(t, 'zn-pkg-n6-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify({ hooks: { packageInstallCheck: 'online' } }));
  const calls = [];
  const packageFetch = (url) => { calls.push(url); throw new Error('must not be called'); };
  const raw = (command) => ({ session_id: 's', cwd: CWD, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1' });
  const run = (command, extra) => runner.handle(getAdapter('claude-code'), raw(command), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home, znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', packageFetch, ...extra });
  const denied = await run('npm i some-invented-package && echo rules >> AGENTS.md', { instructionWrites: 'deny' });
  assert.equal(denied.decision.decision, 'deny');
  assert.deepEqual(calls, [], 'no request for a command that is denied');
  // A command the secret wrapper refuses (a secret marker after the first command) also makes no request.
  const refused = await run('npm i some-invented-package && echo __ZN_DB_PW__', {});
  assert.equal(refused.decision.decision, 'deny');
  assert.deepEqual(calls, [], 'no request for a command the wrapper refuses');
  // Control: without the deny the same command does reach the (fake) fetcher.
  await run('npm i some-invented-package', {});
  assert.equal(calls.length, 1);
});

test('the request options set certificate checks explicitly and only ask for JSON', () => {
  const o = reg.requestOptions(new URL('https://pypi.org/pypi/requests/json'), 5000);
  assert.equal(o.rejectUnauthorized, true);
  assert.equal(o.hostname, 'pypi.org');
  assert.equal(o.method, 'GET');
  assert.deepEqual(Object.keys(o.headers), ['Accept']);
});

test('names beyond the lookup limit are reported as unavailable, not dropped silently', async () => {
  const names = Array.from({ length: 10 }, (_, i) => 'invented-pkg-' + String.fromCharCode(97 + i));
  const asked = [];
  const fetch = (url) => { asked.push(url); return Promise.resolve({ status: 404, body: '' }); };
  const lookup = (items) => reg.lookupMany(items, { fetch });
  const r = await pc.check('pip install ' + names.join(' '), { mode: 'online', lookup });
  assert.equal(asked.length, 8);
  assert.equal(r.findings.filter((f) => f.kind === 'not_found').length, 8);
  assert.deepEqual(r.unavailable.map((u) => u.why), ['too many names', 'too many names']);
});

test('popular names that look like another name are not flagged', () => {
  for (const name of ['motor', 'authlib', 'parse']) assert.deepEqual(pc.installsOf('pip install ' + name).map((i) => i.name), [name]);
  const r = (cmd) => pc.check(cmd, { mode: 'offline' });
  return Promise.all(['pip install motor', 'pip install authlib', 'pip install parse'].map(async (c) => assert.deepEqual((await r(c)).findings, [])));
});

function files(t, map) {
  const dir = tempDir(t, 'zn-pkg-reg-');
  for (const [rel, text] of Object.entries(map)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}
const PRIV_NPM = 'https://npm.corp.example.invalid/';
const PRIV_PIP = '[global]\nindex-url = https://pypi.corp.example.invalid/simple\n';

test('settings files that mark another registry (npm side)', (t) => {
  const none = files(t, {});
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: none, env: {} }), false);
  const cases = {
    '.yarnrc': 'registry "' + PRIV_NPM + '"\n',
    'bunfig.toml': '[install]\nregistry = "' + PRIV_NPM + '"\n',
    '.bunfig.toml': '[install]\nregistry = "' + PRIV_NPM + '"\n',
    '.npmrc': 'registry=' + PRIV_NPM + '\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    const dir = files(t, { [name]: text });
    assert.equal(reg.privateRegistry('npm', { home: dir, cwd: none, env: {} }), true, name + ' in home');
    assert.equal(reg.privateRegistry('npm', { home: none, cwd: dir, env: {} }), true, name + ' in the project');
  }
  const pub = files(t, { '.yarnrc': 'registry "https://registry.yarnpkg.com"\n', 'bunfig.toml': '[install]\nregistry = "https://registry.npmjs.org/"\n' });
  assert.equal(reg.privateRegistry('npm', { home: pub, cwd: pub, env: {} }), false, 'the public registry is not private');
  const custom = files(t, { 'my-npmrc': 'registry=' + PRIV_NPM + '\n' });
  assert.equal(reg.privateRegistry('npm', { home: none, cwd: none, env: { NPM_CONFIG_USERCONFIG: path.join(custom, 'my-npmrc') } }), true);
});

test('settings files that mark another registry (PyPI side)', (t) => {
  const none = files(t, {});
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: {} }), false);
  const home = files(t, { 'Library/Application Support/pip/pip.conf': PRIV_PIP });
  assert.equal(reg.privateRegistry('pypi', { home, cwd: none, env: {} }), true, 'macOS pip.conf');
  const win = files(t, { 'AppData/Roaming/pip/pip.ini': PRIV_PIP });
  assert.equal(reg.privateRegistry('pypi', { home: win, cwd: none, env: {} }), true, 'Windows pip.ini under the home');
  const appdata = files(t, { 'pip/pip.ini': PRIV_PIP });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { APPDATA: appdata } }), true, '%APPDATA%\\pip\\pip.ini');
  const xdg = files(t, { 'pip/pip.conf': PRIV_PIP });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { XDG_CONFIG_HOME: xdg } }), true, 'XDG pip');
  const xdgUv = files(t, { 'uv/uv.toml': '[[index]]\nurl = "https://x.example.invalid"\ndefault-index = "https://x.example.invalid"\n' });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { XDG_CONFIG_HOME: xdgUv } }), true, 'XDG uv');
  const venv = files(t, { 'pip.conf': PRIV_PIP });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { VIRTUAL_ENV: venv } }), true, '$VIRTUAL_ENV/pip.conf');
  const cfg = files(t, { 'custom.conf': PRIV_PIP });
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { PIP_CONFIG_FILE: path.join(cfg, 'custom.conf') } }), true, 'PIP_CONFIG_FILE');
  assert.equal(reg.privateRegistry('pypi', { home: none, cwd: none, env: { UV_CONFIG_FILE: path.join(cfg, 'custom.conf') } }), true, 'UV_CONFIG_FILE');
});
