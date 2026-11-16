'use strict';

process.env.ZN_STATS = 'off';
delete process.env.ZN_PACKAGE_CHECK;

// Package install check, notices: the version notices have a lookup budget of their own (they never take a
// lookup from a question), the lockfile note is exact (global installs, --ignore-scripts, wording), and a registry
// reply over 4 MiB gives no note. Fictitious names; the registry is a fake fetcher and the clock is fixed.

const test = require('node:test');
const assert = require('node:assert/strict');

const pc = require('../lib/package-check');
const reg = require('../lib/package-registry');
const NAMES = require('../lib/data/package-names.json');

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const now = () => NOW;
const BOTH = new Set(['fresh_version', 'no_lockfile']);
const FRESH_ONLY = new Set(['fresh_version']);
const LOCK_ONLY = new Set(['no_lockfile']);
const NPM = (n) => 'https://registry.npmjs.org/' + n;
const json = (o) => ({ status: 200, body: JSON.stringify(o) });

/* An npm document: the first release long ago, the latest tag, and the publish time (hours ago) of each version. */
function npmDoc(latest, versions) {
  const time = { created: new Date(NOW - 400 * 24 * HOUR).toISOString() };
  for (const [v, h] of Object.entries(versions)) time[v] = new Date(NOW - h * HOUR).toISOString();
  return json({ name: 'x', 'dist-tags': { latest }, time });
}

/* A fake registry: `answer(url)` gives { status, body }, an Error, or nothing (a 404). Every URL asked is recorded. */
function fakeFetch(answer) {
  const calls = [];
  const fetch = (url) => {
    calls.push(url);
    const a = answer(url);
    if (a instanceof Error) throw a;
    return Promise.resolve(a || { status: 404, body: '' });
  };
  fetch.calls = calls;
  return fetch;
}

const lookupWith = (fetch) => (items) => reg.lookupMany(items, { fetch, now });

/* Names on the bundled starter list: unscoped, lower case, not too short. */
function knownNpm(n) {
  return NAMES.npm.filter((x) => !x.startsWith('@') && x.length >= 5 && x === x.toLowerCase()).slice(0, n);
}

/* ------------------------------------ budget ------------------------------------ */

test('budget: eight well-known names with a fresh version do not stop the question about one unknown name', async () => {
  const known = knownNpm(8);
  assert.equal(known.length, 8, 'eight names on the starter list');
  const unknown = 'zz-unlisted-pkg-7781';
  const fetch = fakeFetch((url) => (url === NPM(unknown) ? null : npmDoc('1.0.0', { '1.0.0': 1 })));
  const cmd = 'npm i ' + known.map((k) => k + '@1.0.0').join(' ') + ' ' + unknown;
  const r = await pc.check(cmd, { mode: 'online', lookup: lookupWith(fetch), notices: BOTH });
  assert.ok(fetch.calls.includes(NPM(unknown)), 'the unknown name is still asked');
  assert.deepEqual(r.findings.map((f) => [f.name, f.kind]), [[unknown, 'not_found']], 'and its answer is still a question');
  assert.equal(r.notices.filter((n) => n.kind === 'fresh_version').length, 8, 'each well-known name still gets its version note');
});

test('budget: the questions are asked the same way with the version notices on or off', async () => {
  const names = Array.from({ length: 9 }, (_, i) => 'zz-unlisted-pkg-' + (7800 + i));
  const cmd = 'npm i ' + names.join(' ');
  const run = async (notices) => {
    const fetch = fakeFetch(() => null);
    const r = await pc.check(cmd, { mode: 'online', lookup: lookupWith(fetch), notices });
    return { asked: fetch.calls, unavailable: r.unavailable.map((u) => [u.name, u.why]), findings: r.findings.length };
  };
  const off = await run(new Set());
  const on = await run(BOTH);
  assert.equal(off.asked.length, 8, 'the question budget is the registry limit of 8');
  assert.deepEqual(on.asked, off.asked, 'the same names are asked, in the same order');
  assert.deepEqual(on.unavailable, off.unavailable);
  assert.deepEqual(on.unavailable, [[names[8], 'too many names']]);
  assert.equal(on.findings, off.findings);
});

test('budget: a look-alike with a pinned version gets its question and no registry request', async () => {
  const fetch = fakeFetch(() => null);
  const r = await pc.check('npm i lodsh@1.0.0', { mode: 'online', lookup: lookupWith(fetch), notices: FRESH_ONLY });
  assert.deepEqual(fetch.calls, [], 'no request for a look-alike');
  assert.deepEqual(r.findings.map((f) => f.name), ['lodsh']);
});

/* ------------------------------------ lockfile ------------------------------------ */

test('lockfile note: a global install is never noted', async () => {
  const cmds = ['npm install -g', 'npm i -g lodash', 'npm install --global', 'npm install --global=true lodash',
    'npm install --location=global lodash', 'npm -g install lodash'];
  for (const cmd of cmds) {
    const r = await pc.check(cmd, { mode: 'offline', notices: LOCK_ONLY });
    assert.deepEqual(r.notices, [], cmd);
  }
  const project = await pc.check('npm install lodash', { mode: 'offline', notices: LOCK_ONLY });
  assert.deepEqual(project.notices.map((n) => n.kind), ['no_lockfile'], 'a project install is still noted');
});

test('lockfile note: no --ignore-scripts suggestion when the command already has it', async () => {
  const text = async (cmd) => pc.noticeOf((await pc.check(cmd, { mode: 'offline', notices: LOCK_ONLY })).notices);
  assert.match(await text('npm install'), /--ignore-scripts/, 'without the flag the suggestion is given');
  for (const cmd of ['npm install --ignore-scripts', 'npm i lodash --ignore-scripts=true', "sh -c 'npm install --ignore-scripts'"]) {
    const t = await text(cmd);
    assert.match(t, /npm ci/, cmd);
    assert.doesNotMatch(t, /ignore-scripts/, cmd);
  }
  assert.match(await text('npm install --ignore-scripts --no-ignore-scripts'), /--ignore-scripts/, 'the last flag wins');
  assert.match(await text('npm install --ignore-scripts && npm install lodash'), /--ignore-scripts/, 'one install without the flag is enough');
});

test('lockfile note: says that npm install uses the lockfile without requiring it, and that npm ci installs exactly it', async () => {
  const t = pc.noticeOf((await pc.check('npm install lodash', { mode: 'offline', notices: LOCK_ONLY })).notices);
  assert.doesNotMatch(t, /does not install from the lockfile/);
  assert.match(t, /uses the lockfile but does not require it and may update it/);
  assert.match(t, /`npm ci` installs exactly what the lockfile records/);
});

/* ------------------------------------ 4 MiB ------------------------------------ */

test('a registry reply over 4 MiB gives no version note; for a name off the list it is an unavailable answer', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024 + 1);
  const fetch = fakeFetch(() => ({ status: 200, body: '{"name":"' + big + '"}' }));
  const notice = await pc.check('npm i react@18.3.1', { mode: 'online', lookup: lookupWith(fetch), notices: FRESH_ONLY });
  assert.deepEqual(fetch.calls, [NPM('react')], 'react is asked for the version note');
  assert.deepEqual(notice.notices, [], 'and no note is shown');
  assert.deepEqual(notice.unavailable, [], 'a note is not a question');
  const question = await pc.check('npm i zz-unlisted-pkg-7781@1.0.0', { mode: 'online', lookup: lookupWith(fetch), notices: FRESH_ONLY });
  assert.deepEqual(question.findings, []);
  assert.deepEqual(question.unavailable.map((u) => u.why), ['reply too large']);
});
