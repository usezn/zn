'use strict';

process.env.ZN_STATS = 'off';
delete process.env.ZN_PACKAGE_CHECK;

// Package install check, notices (hooks.packageInstallNotices): a version published less than 72 hours ago, and an
// `npm install` that does not use the lockfile. Notes only: they never ask, never block, and they are off unless the
// config file turns them on. Fictitious package names; the registry is a fake fetcher and the clock is fixed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pc = require('../lib/package-check');
const reg = require('../lib/package-registry');
const settings = require('../lib/package-check-settings');
const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const CWD = path.join(path.sep, 'work', 'proj');
const ago = (h) => new Date(NOW - h * HOUR).toISOString();
const now = () => NOW;
const BOTH = new Set(['fresh_version', 'no_lockfile']);
const FRESH_ONLY = new Set(['fresh_version']);
const LOCK_ONLY = new Set(['no_lockfile']);
const NONE = new Set();

/* A fake registry: `answers` maps a URL to { status, body } (or a function); every URL asked is recorded. */
function fakeFetch(answers) {
  const calls = [];
  const fetch = (url) => {
    calls.push(url);
    const a = typeof answers === 'function' ? answers(url) : answers[url];
    if (a instanceof Error) throw a;
    return Promise.resolve(a || { status: 404, body: '' });
  };
  fetch.calls = calls;
  return fetch;
}

const NPM = (n) => 'https://registry.npmjs.org/' + n;
const PYPI = (n) => 'https://pypi.org/pypi/' + n + '/json';
const json = (o) => ({ status: 200, body: JSON.stringify(o) });

/* An npm document: the first release long ago, the latest tag, and the publish time (hours ago) of each version. */
function npmDoc(latest, versions) {
  const time = { created: ago(24 * 400) };
  for (const [v, h] of Object.entries(versions)) time[v] = ago(h);
  return json({ name: 'x', 'dist-tags': { latest }, time });
}

/* A PyPI document: the latest version, and the upload time (hours ago) of each release. */
function pypiDoc(latest, releases) {
  const rel = {};
  for (const [v, h] of Object.entries(releases)) rel[v] = [{ upload_time_iso_8601: ago(h) }];
  return json({ info: { name: 'x', version: latest }, releases: rel });
}

function online(command, fetch, notices) {
  const lookup = (items) => reg.lookupMany(items, { fetch, now });
  return pc.check(command, { mode: 'online', lookup, notices });
}

/* ------------------------------------ settings ------------------------------------ */

test('settings: notices are off unless the config file lists them', () => {
  assert.deepEqual([...settings.noticesOf(undefined)], []);
  assert.deepEqual([...settings.noticesOf(false)], []);
  assert.deepEqual([...settings.noticesOf('yes')], []);
  assert.deepEqual([...settings.noticesOf(['fresh_version', 'made_up'])], ['fresh_version']);
  assert.deepEqual([...settings.noticesOf(true)].sort(), ['fresh_version', 'no_lockfile']);
  assert.deepEqual([...settings.settingsOf({ packageInstallCheck: 'online' }).notices], []);
  assert.deepEqual([...settings.settingsOf({ packageInstallCheck: 'online', packageInstallNotices: ['no_lockfile'] }).notices], ['no_lockfile']);
});

/* --------------------------------- lockfile notice --------------------------------- */

test('lockfile: npm install and npm i without ci are noted, offline, and only when switched on', async () => {
  const kinds = async (cmd, notices) => (await pc.check(cmd, { mode: 'offline', notices })).notices.map((n) => n.kind);
  assert.deepEqual(await kinds('npm install', LOCK_ONLY), ['no_lockfile']);
  assert.deepEqual(await kinds('npm i', LOCK_ONLY), ['no_lockfile']);
  assert.deepEqual(await kinds('npm install lodash', LOCK_ONLY), ['no_lockfile']);
  assert.deepEqual(await kinds('npm ci', LOCK_ONLY), []);
  assert.deepEqual(await kinds('npm ci && npm install lodash', LOCK_ONLY), ['no_lockfile']);
  assert.deepEqual(await kinds("sh -c 'npm i lodash'", LOCK_ONLY), ['no_lockfile']);
  assert.deepEqual(await kinds('pnpm install', LOCK_ONLY), []);
  assert.deepEqual(await kinds('pip install requests', LOCK_ONLY), []);
  assert.deepEqual(await kinds('npm install', NONE), [], 'opt-in off: no note');
  assert.deepEqual(await kinds('npm install', FRESH_ONLY), [], 'the fresh-version notice does not note the lockfile');
});

test('lockfile: the note names the --ignore-scripts suggestion and never a question', async () => {
  const r = await pc.check('npm install', { mode: 'offline', notices: LOCK_ONLY });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.unavailable, []);
  const text = pc.noticeOf(r.notices);
  assert.match(text, /^zn notice \(the command still runs\): /);
  assert.match(text, /npm ci/);
  assert.match(text, /--ignore-scripts/);
});

/* ----------------------------------- fresh version ----------------------------------- */

test('fresh version: a pinned version published less than 72 hours ago is noted with its age', async () => {
  const f = fakeFetch({ [NPM('demo-fresh-thing')]: npmDoc('1.2.3', { '1.2.3': 5 }) });
  const r = await online('npm i demo-fresh-thing@1.2.3', f, FRESH_ONLY);
  assert.deepEqual(r.notices.map((n) => [n.kind, n.name, n.version, n.hours]), [['fresh_version', 'demo-fresh-thing', '1.2.3', 5]]);
  assert.deepEqual(r.findings, []);
});

test('fresh version: a name with no version is judged by the latest release', async () => {
  const f = fakeFetch({ [NPM('demo-fresh-thing')]: npmDoc('2.0.0', { '1.0.0': 900, '2.0.0': 2 }) });
  const r = await online('npm i demo-fresh-thing', f, FRESH_ONLY);
  assert.deepEqual(r.notices.map((n) => [n.version, n.hours]), [['2.0.0', 2]]);
});

test('fresh version: an old version, a range and a tag are not noted', async () => {
  const f = fakeFetch({
    [NPM('demo-old-thing')]: npmDoc('1.0.0', { '1.0.0': 100 }),
    [NPM('demo-range-thing')]: npmDoc('1.4.0', { '1.4.0': 1 }),
  });
  assert.deepEqual((await online('npm i demo-old-thing@1.0.0', f, FRESH_ONLY)).notices, []);
  assert.deepEqual((await online('npm i demo-range-thing@^1.0.0', f, FRESH_ONLY)).notices, [], 'a range: the version is not known');
  assert.deepEqual((await online('npm i demo-range-thing@next', f, FRESH_ONLY)).notices, [], 'a tag: the version is not known');
});

test('fresh version: PyPI, a pinned release and the latest one', async () => {
  const f = fakeFetch({ [PYPI('demo-fresh-pkg')]: pypiDoc('2.1', { '2.0': 300, '2.1': 3 }) });
  assert.deepEqual((await online('pip install demo-fresh-pkg==2.0', f, FRESH_ONLY)).notices, [], '2.0 is 300 hours old');
  const r = await online('pip install demo-fresh-pkg', f, FRESH_ONLY);
  assert.deepEqual(r.notices.map((n) => [n.eco, n.version, n.hours]), [['pypi', '2.1', 3]]);
});

test('fresh version: a well-known name is still noted when its new version is fresh, and never asked about', async () => {
  const f = fakeFetch({ [NPM('lodash')]: npmDoc('4.17.99', { '4.17.99': 1 }) });
  const r = await online('npm i lodash', f, FRESH_ONLY);
  assert.deepEqual(r.notices.map((n) => [n.name, n.version]), [['lodash', '4.17.99']]);
  assert.deepEqual(r.findings, []);
});

test('fresh version: a fresh lookalike keeps its question, and the result is never a deny', async () => {
  const f = fakeFetch({});
  const r = await online('npm i lodsh && npm install', f, BOTH);
  assert.deepEqual(r.findings.map((x) => x.name), ['lodsh']);
  assert.deepEqual(r.notices.map((n) => n.kind), ['no_lockfile']);
  assert.equal('decision' in r, false);
});

test('opt-in off: no note and no version lookup, whatever the registry says', async () => {
  const f = fakeFetch({
    [NPM('demo-fresh-thing')]: npmDoc('2.0.0', { '2.0.0': 2 }),
    [NPM('lodash')]: npmDoc('4.17.99', { '4.17.99': 1 }),
  });
  const r = await online('npm i demo-fresh-thing && npm i lodash', f, NONE);
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.findings, []);
  // Only the unknown name is looked up (for the question); the well-known one is not asked about at all.
  assert.deepEqual(f.calls, [NPM('demo-fresh-thing')]);
});

test('offline mode never looks up a version', async () => {
  const f = fakeFetch({});
  const r = await pc.check('pip install demo-fresh-pkg', { mode: 'offline', notices: BOTH });
  assert.deepEqual(r.notices, []);
  assert.equal(f.calls.length, 0);
});

test('a lookup that fails for a well-known name gives no note and no question', async () => {
  const f = fakeFetch({ [NPM('lodash')]: new Error('network down') });
  const r = await online('npm i lodash', f, FRESH_ONLY);
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.unavailable, [], 'a fresh-version lookup is not a question, so it is not reported as one');
});

test('a lookup that fails for an unknown name is reported as unavailable, as before, and gives no note', async () => {
  const f = fakeFetch({ [NPM('demo-fresh-thing')]: new Error('network down') });
  const r = await online('npm i demo-fresh-thing', f, FRESH_ONLY);
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.unavailable.map((u) => [u.name, u.why]), [['demo-fresh-thing', 'network down']]);
});

/* ------------------------------------- cache ------------------------------------- */

test('cache: a latest-version answer is kept for an hour, a pinned one for a day', async (t) => {
  const dir = tempDir(t, 'zn-notices-cache-');
  const f = fakeFetch({ [NPM('demo-fresh-thing')]: npmDoc('2.0.0', { '2.0.0': 2, '1.0.0': 900 }) });
  const look = (items, at) => reg.lookupMany(items, { fetch: f, now: () => at, stateDir: dir });
  const latest = [{ eco: 'npm', name: 'demo-fresh-thing', version: 'latest' }];
  const pinned = [{ eco: 'npm', name: 'demo-fresh-thing', version: '1.0.0' }];
  await look(latest, NOW);
  assert.equal(f.calls.length, 1);
  await look(latest, NOW + HOUR / 2);
  assert.equal(f.calls.length, 1, 'within the hour: from the cache');
  await look(latest, NOW + 2 * HOUR);
  assert.equal(f.calls.length, 2, 'after the hour: asked again');
  await look(pinned, NOW + 2 * HOUR);
  assert.equal(f.calls.length, 3, 'a pinned version is not in the cache yet');
  const r = await look(pinned, NOW + 10 * HOUR);
  assert.equal(f.calls.length, 3, 'a pinned version stays cached for a day');
  assert.equal(r.get('npm:demo-fresh-thing').version, '1.0.0');
});

/* ------------------------------------- hooks ------------------------------------- */

function homeWith(t, hooks) {
  const home = tempDir(t, 'zn-notices-hooks-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  if (hooks) fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify({ hooks }));
  return home;
}

const RAW = (command) => ({ session_id: 's', cwd: CWD, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1' });

function handle(command, home, extra = {}) {
  return runner.handle(getAdapter('claude-code'), RAW(command), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home, znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', ...extra });
}

const decisionOf = (res) => (res.output && res.output.hookSpecificOutput && res.output.hookSpecificOutput.permissionDecision) || 'none';
const noted = (res) => /zn notice/.test(JSON.stringify(res));

test('hooks: a fresh version is noted on an allowed command, never asked, never denied', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'online', packageInstallNotices: true });
  const f = fakeFetch({ [NPM('demo-fresh-thing')]: npmDoc('1.2.3', { '1.2.3': 5 }) });
  const res = await handle('npm i demo-fresh-thing@1.2.3', home, { packageFetch: f, packageNow: now });
  assert.equal(decisionOf(res), 'none', 'no decision of its own: the command runs as it would without the check');
  assert.equal(noted(res), true);
});

test('hooks: no note when the notices are off, or the check is off', async (t) => {
  const f1 = fakeFetch({ [NPM('demo-fresh-thing')]: npmDoc('1.2.3', { '1.2.3': 5 }) });
  const res1 = await handle('npm i demo-fresh-thing@1.2.3', homeWith(t, { packageInstallCheck: 'online' }), { packageFetch: f1, packageNow: now });
  assert.equal(noted(res1), false);
  assert.notEqual(decisionOf(res1), 'deny');
  const f2 = fakeFetch({ [NPM('demo-fresh-thing')]: npmDoc('1.2.3', { '1.2.3': 5 }) });
  const res2 = await handle('npm i demo-fresh-thing@1.2.3', homeWith(t, { packageInstallCheck: 'off', packageInstallNotices: true }), { packageFetch: f2, packageNow: now });
  assert.equal(noted(res2), false);
  assert.equal(f2.calls.length, 0, 'check off: the registry is never asked');
});

test('hooks: the lockfile note is shown with the offline check, and npm ci gets none', async (t) => {
  const home = homeWith(t, { packageInstallCheck: 'offline', packageInstallNotices: ['no_lockfile'] });
  assert.equal(noted(await handle('npm install', home)), true);
  assert.equal(noted(await handle('npm ci', home)), false);
  assert.notEqual(decisionOf(await handle('npm install', home)), 'deny');
});

test('fresh version: a command that is not a plain install gets no note and no registry request', async () => {
  const f = fakeFetch({ [NPM('demo-fresh-thing')]: npmDoc('1.2.3', { '1.2.3': 5 }) });
  const commands = [
    'npm i demo-fresh-thing@1.2.3 --registry https://npm.example.com',
    'cat .npmrc && npm i demo-fresh-thing@1.2.3',
    'npm i demo-fresh-thing@1.2.3 && npm i demo-fresh-thing@1.2.3 > install.log',
  ];
  for (const c of commands) assert.deepEqual((await online(c, f, FRESH_ONLY)).notices, [], c);
  assert.equal(f.calls.length, 0, 'the fail-closed rule: a line that is not plain asks the registry for nothing');
});

test('lockfile note: a command that is not a plain install is still read from its text, and makes no request', async () => {
  const f = fakeFetch({});
  const r = await online('npm i demo-fresh-thing --registry https://npm.example.com', f, LOCK_ONLY);
  assert.deepEqual(r.notices.map((n) => n.kind), ['no_lockfile']);
  assert.equal(f.calls.length, 0);
});
