'use strict';

process.env.ZN_STATS = 'off';
delete process.env.ZN_PACKAGE_CHECK;

// Package install check inside the agent hooks: off by default and then exactly as before, offline and online
// modes through the settings, what each agent does with the question, the allow list and the decision log.
// Only fictitious package names. No network: the online mode gets a fake fetcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const CWD = path.join(path.sep, 'work', 'proj');
const NOW = Date.UTC(2026, 10, 5);

function homeWith(t, hooks) {
  const home = tempDir(t, 'zn-pkg-hooks-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  if (hooks) fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify({ hooks }));
  return home;
}

const RAW = {
  'claude-code': (command, cwd = CWD) => ({ session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1' }),
  codex: (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: CWD }),
  cursor: (command) => ({ hook_event_name: 'beforeShellExecution', command, cwd: CWD }),
  opencode: (command) => ({ hook: 'tool.execute.before', tool: 'bash', args: { command }, cwd: CWD }),
  gemini: (command) => ({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command }, cwd: CWD }),
};

function handle(agent, command, home, extra = {}, cwd) {
  return runner.handle(getAdapter(agent), RAW[agent](command, cwd), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home, znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', ...extra });
}

const asked = (res) => Boolean(res.output && res.output.hookSpecificOutput && res.output.hookSpecificOutput.permissionDecision === 'ask');
const reasonOf = (res) => (res.output && res.output.hookSpecificOutput && res.output.hookSpecificOutput.permissionDecisionReason) || '';

function evidenceOf(home) {
  const file = path.join(home, '.zn', 'evidence.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const INSTALLS = [
  'npm install lodash', 'npm i lodsh', 'npm install -g typescript', 'npm i @babell/core', 'npm ci', 'npm install',
  'pnpm add react', 'yarn add reactt', 'bun add zod', 'pip install requests', 'pip install reqeusts', 'pip install -r requirements.txt',
  'python -m pip install numpyy', 'uv add httpx', 'pipx install blackk', 'cd app && npm i expreess', 'sudo pip install requests',
  'npm install some-invented-package', 'ls -la', 'git status',
];

/* --------------------------------- off by default --------------------------------- */

test('off: the decisions for a table of install commands are the plain allow, with or without the setting', async (t) => {
  const bare = homeWith(t, null);
  const off = homeWith(t, { packageInstallCheck: 'off' });
  const falseSetting = homeWith(t, { packageInstallCheck: false });
  const neverFetch = () => { throw new Error('a lookup was made while the check is off'); };
  for (const command of INSTALLS) {
    const results = [];
    for (const [home, extra] of [[bare, {}], [off, {}], [falseSetting, {}], [bare, { packageInstallCheck: 'off', packageFetch: neverFetch }], [bare, { packageFetch: neverFetch }]]) {
      results.push(await handle('claude-code', command, home, extra));
    }
    for (const r of results) {
      assert.deepEqual(r, results[0], command);
      assert.equal(r.output, null, command);
      assert.deepEqual(r.decision, { decision: 'allow' }, command);
      assert.equal(r.stderr, null, command);
    }
  }
  for (const home of [bare, off, falseSetting]) assert.deepEqual(evidenceOf(home), [], 'nothing is logged');
});

test('off: the feature modules are not even loaded, and nothing is written or sent', () => {
  const script = [
    "process.env.ZN_STATS = 'off';",
    "const fs = require('fs'), path = require('path'), os = require('os');",
    "const pkg = process.argv[1];",
    "const { getAdapter } = require(pkg + '/lib/agents');",
    "const runner = require(pkg + '/lib/hooks/runner');",
    "const fakeEngine = require(pkg + '/test/helpers/fake_engine');",
    "const { createFakeVault } = require(pkg + '/test/helpers/fake_vault');",
    "const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pkg-off-'));",
    "const boom = (n) => () => { throw new Error('touched ' + n); };",
    "for (const m of ['https', 'http', 'net', 'tls']) { const mod = require(m); for (const f of ['request', 'get', 'connect']) if (mod[f]) mod[f] = boom(m + '.' + f); }",
    "// Reads stay open: the check reads the settings file to learn that it is off. Only write-mode opens are blocked.",
    "for (const f of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync']) fs[f] = boom('fs.' + f);",
    "const realOpenSync = fs.openSync;",
    "fs.openSync = (p, flags, ...rest) => (flags === undefined || flags === 'r' || flags === 'rs' ? realOpenSync(p, flags, ...rest) : boom('fs.openSync ' + flags)());",
    "(async () => {",
    "  for (const command of ['npm i lodsh', 'pip install reqeusts', 'npm install some-invented-package']) {",
    "    const raw = { session_id: 's', cwd: '/work/proj', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' };",
    "    const r = await runner.handle(getAdapter('claude-code'), raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home, packageFetch: boom('fetch') });",
    "    if (r.output !== null || r.decision.decision !== 'allow') throw new Error('unexpected decision for ' + command);",
    "  }",
    "  const loaded = Object.keys(require.cache).filter((k) => /package-(check|registry)\\.js$/.test(k));",
    "  process.stdout.write(JSON.stringify({ loaded }));",
    "})().catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });",
  ].join('\n');
  const res = spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '..')], { encoding: 'utf8', env: { ...process.env, ZN_PACKAGE_CHECK: '' } });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { loaded: [] });
});

test('offline: the check modules touch neither the network nor the disk', async () => {
  const https = require('https');
  const http = require('http');
  const net = require('net');
  const saved = [];
  const boom = (name) => () => { throw new Error('touched ' + name); };
  const patch = (obj, key, label) => { saved.push([obj, key, obj[key]]); obj[key] = boom(label); };
  const pc = require('../lib/package-check');
  try {
    for (const k of ['request', 'get']) { patch(https, k, 'https.' + k); patch(http, k, 'http.' + k); }
    patch(net, 'connect', 'net.connect');
    for (const k of ['readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'openSync', 'readdirSync', 'statSync', 'existsSync', 'unlinkSync']) patch(fs, k, 'fs.' + k);
    const lookup = () => { throw new Error('offline mode asked for a lookup'); };
    const r = await pc.check('npm i lodsh some-invented-package && pip install reqeusts', { mode: 'offline', lookup });
    assert.equal(r.findings.length, 2);
    assert.ok(pc.messageOf(r.findings));
  } finally {
    for (const [obj, key, fn] of saved.reverse()) obj[key] = fn;
  }
});

/* ----------------------------------- offline mode ----------------------------------- */

test('offline from the config file: a look-alike asks, an exact name and a plain install do not', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline' });
  const neverFetch = () => { throw new Error('offline mode made a lookup'); };
  const hit = await handle('claude-code', 'npm i lodsh', home, { packageFetch: neverFetch });
  assert.equal(asked(hit), true);
  assert.match(reasonOf(hit), /`lodsh`/);
  assert.match(reasonOf(hit), /did you mean `lodash`\?/);
  assert.equal(hit.decision.decision, 'ask');
  assert.equal(hit.decision.soft, true, 'a soft question: an agent that cannot ask lets the command run');
  for (const fine of ['npm i lodash', 'npm ci', 'pip install -r requirements.txt', 'npm install some-invented-package', 'ls -la', 'pip install Flask_CORS']) {
    const r = await handle('claude-code', fine, home, { packageFetch: neverFetch });
    assert.equal(r.output, null, fine);
  }
});

test('offline from the environment: ZN_PACKAGE_CHECK=offline asks; online from the environment is only offline and makes no lookup', async (t) => {
  const home = homeWith(t, null);
  const calls = [];
  const fetch = (u) => { calls.push(u); return Promise.resolve({ status: 404, body: '' }); };
  process.env.ZN_PACKAGE_CHECK = 'offline';
  try {
    assert.equal(asked(await handle('claude-code', 'npm i lodsh', home, { packageFetch: fetch })), true);
    process.env.ZN_PACKAGE_CHECK = 'online';
    assert.equal(asked(await handle('claude-code', 'npm i lodsh', home, { packageFetch: fetch })), true);
    assert.equal((await handle('claude-code', 'npm i some-invented-package', home, { packageFetch: fetch })).output, null);
    process.env.ZN_PACKAGE_CHECK = '0';
    assert.equal((await handle('claude-code', 'npm i lodsh', home, { packageFetch: fetch })).output, null);
  } finally {
    delete process.env.ZN_PACKAGE_CHECK;
  }
  assert.deepEqual(calls, []);
});

test('the environment cannot lower what the config file says', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline' });
  process.env.ZN_PACKAGE_CHECK = 'off';
  try {
    assert.equal(asked(await handle('claude-code', 'npm i lodsh', home)), true);
  } finally {
    delete process.env.ZN_PACKAGE_CHECK;
  }
});

test('allow list: a name on hooks.packageInstallAllow is not asked about', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline', packageInstallAllow: ['lodsh', '@babell/*', 'Reqeusts'] });
  assert.equal((await handle('claude-code', 'npm i lodsh', home)).output, null);
  assert.equal((await handle('claude-code', 'npm i @babell/core', home)).output, null);
  assert.equal((await handle('claude-code', 'pip install reqeusts', home)).output, null);
  assert.equal(asked(await handle('claude-code', 'npm i expreess', home)), true);
});

test('several packages in one command make one question that names them', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline' });
  const reason = reasonOf(await handle('claude-code', 'npm i lodsh expreess && pip install reqeusts', home));
  assert.equal((reason.match(/zn: /g) || []).length, 1);
  for (const n of ['lodsh', 'expreess', 'reqeusts']) assert.match(reason, new RegExp('`' + n + '`'));
});

test('a command that zn already refuses stays refused, with its own message', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline' });
  const r = await handle('claude-code', 'mkfs.ext4 /dev/sda1 && npm i lodsh', home);
  assert.equal(r.decision.decision, 'deny');
  assert.doesNotMatch(r.decision.message, /lodsh/);
});

test('it never denies: a question joins the other questions of the same call, it does not replace them', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline' });
  const r = await handle('claude-code', 'npm i lodsh && echo hi >> AGENTS.md', home);
  assert.equal(r.decision.decision, 'ask');
  assert.match(reasonOf(r), /AGENTS\.md/);
  assert.match(reasonOf(r), /lodsh/);
});

/* ------------------------------ what each agent does ------------------------------ */

test('agents that can ask ask; agents that cannot ask let the command run (never a block)', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline' });
  const claude = await handle('claude-code', 'npm i lodsh', home);
  assert.equal(claude.output.hookSpecificOutput.permissionDecision, 'ask');
  const cursor = await handle('cursor', 'npm i lodsh', home);
  assert.equal(cursor.output.permission, 'ask');
  assert.match(cursor.output.user_message, /lodash/);
  for (const agent of ['codex', 'opencode', 'gemini']) {
    const r = await handle(agent, 'npm i lodsh', home);
    assert.equal(JSON.stringify(r.output).includes('deny'), false, agent + ' must not be blocked');
    assert.ok(r.output === null || r.output.action === 'none', agent + ': ' + JSON.stringify(r.output));
    assert.equal(r.decision.decision, 'ask', agent + ': the question is still the decision that is logged');
  }
});

/* ------------------------------------ online mode ------------------------------------ */

test('online from the config file: a 404 asks, an old package and a failed lookup do not, and the cache is under .zn', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'online' });
  const answers = {
    'https://registry.npmjs.org/some-invented-package': { status: 404, body: '' },
    'https://registry.npmjs.org/old-package': { status: 200, body: JSON.stringify({ time: { created: '2015-01-01T00:00:00.000Z' } }) },
    'https://registry.npmjs.org/broken-package': { status: 503, body: '' },
  };
  const calls = [];
  const fetch = (url) => { calls.push(url); return Promise.resolve(answers[url]); };
  const extra = { packageFetch: fetch, packageNow: () => NOW };
  const miss = await handle('claude-code', 'npm i some-invented-package', home, extra);
  assert.equal(asked(miss), true);
  assert.match(reasonOf(miss), /not found on the npm registry/);
  assert.equal((await handle('claude-code', 'npm i old-package', home, extra)).output, null);
  const broken = await handle('claude-code', 'npm i broken-package', home, extra);
  assert.equal(broken.output, null, 'a failed lookup asks nothing');
  assert.equal(broken.decision.decision, 'allow');
  assert.deepEqual(calls, Object.keys(answers));
  assert.ok(fs.existsSync(path.join(home, '.zn', 'package-registry-cache.json')));
  await handle('claude-code', 'npm i some-invented-package', home, extra);
  assert.equal(calls.length, 3, 'the answer came from the cache');
});

test('online: a recent package asks, and a registry set in the user settings is never asked', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'online' });
  const calls = [];
  const fetch = (url) => { calls.push(url); return Promise.resolve({ status: 200, body: JSON.stringify({ time: { created: new Date(Date.UTC(2026, 10, 1)).toISOString() } }) }); };
  const extra = { packageFetch: fetch, packageNow: () => NOW };
  const r = await handle('claude-code', 'npm i fresh-package', home, extra);
  assert.equal(asked(r), true);
  assert.match(reasonOf(r), /first published 4 days ago/);
  // The project the agent works in names another registry: nothing is sent to the public one.
  const project = tempDir(t, 'zn-pkg-project-');
  fs.writeFileSync(path.join(project, '.npmrc'), '@acme:registry=https://npm.example.com/\n');
  const before = calls.length;
  const r2 = await handle('claude-code', 'npm i other-package', home, extra, project);
  assert.equal(r2.output, null);
  assert.equal(calls.length, before, 'a private registry is configured: the public one is not asked');
});

/* ----------------------------------- decision log ----------------------------------- */

test('decision log: a finding is written as an allow record with the rule, the package and no command', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline' });
  await handle('claude-code', 'GITHUB_TOKEN=ghp_notreal123 npm i lodsh --save-dev', home);
  const rows = evidenceOf(home);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.rule, 'hook-package-check-look-alike');
  assert.equal(row.verdict, 'allow');
  assert.equal(row.engine, 'zn-hook');
  assert.match(row.reason, /`lodsh`/);
  assert.match(row.reason, /lodash/);
  assert.doesNotMatch(JSON.stringify(row), /ghp_|--save-dev|npm i/);
});

test('decision log: a lookup that gave no answer is noted, and no question is asked', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'online' });
  const fetch = () => Promise.reject(new Error('ETIMEDOUT'));
  const r = await handle('claude-code', 'npm i some-invented-package', home, { packageFetch: fetch });
  assert.equal(r.output, null);
  const rows = evidenceOf(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rule, 'hook-package-check-unavailable');
  assert.match(rows[0].reason, /no answer/);
  assert.match(rows[0].reason, /ETIMEDOUT/);
  assert.match(rows[0].reason, /no question was asked/);
});

test('decision log: not-found and new packages have their own rules', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'online' });
  const fetch = (url) => Promise.resolve(url.endsWith('/gone-package') ? { status: 404, body: '' } : { status: 200, body: JSON.stringify({ time: { created: new Date(Date.UTC(2026, 10, 4)).toISOString() } }) });
  const extra = { packageFetch: fetch, packageNow: () => NOW };
  await handle('claude-code', 'npm i gone-package', home, extra);
  await handle('claude-code', 'npm i young-package', home, extra);
  assert.deepEqual(evidenceOf(home).map((r) => r.rule), ['hook-package-check-not-found', 'hook-package-check-new']);
});

test('decision log: a problem writing the log never changes the answer', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline' });
  fs.mkdirSync(path.join(home, '.zn', 'evidence.jsonl'));
  const r = await handle('claude-code', 'npm i lodsh', home);
  assert.equal(asked(r), true);
});
