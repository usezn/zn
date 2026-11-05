'use strict';

process.env.ZN_STATS = 'off';

// Package install check, online mode, with a fake fetcher and a fake clock: no network is used. Whatever the
// registry would answer is made up here (the dates are relative to a fixed "now").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pc = require('../lib/package-check');
const reg = require('../lib/package-registry');
const { tempDir } = require('./helpers/tmp');

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const now = () => NOW;

/* A fake registry: `answers` maps a URL to { status, body } (or a function), and every URL asked is recorded. */
function fakeFetch(answers) {
  const calls = [];
  const fetch = (url, options) => {
    calls.push({ url, options });
    const a = typeof answers === 'function' ? answers(url) : answers[url];
    if (a instanceof Error) throw a;
    if (typeof a === 'function') return a();
    return Promise.resolve(a || { status: 404, body: '' });
  };
  fetch.calls = calls;
  return fetch;
}

const npmDoc = (days) => ({ status: 200, body: JSON.stringify({ name: 'x', time: { created: ago(days) } }) });
const pypiDoc = (...days) => ({
  status: 200,
  body: JSON.stringify({ info: { name: 'x' }, releases: Object.fromEntries(days.map((d, i) => ['1.' + i, [{ upload_time_iso_8601: ago(d) }]])) }),
});

async function online(command, fetch, extra = {}) {
  const stateDir = extra.stateDir;
  const lookup = (items) => reg.lookupMany(items, { fetch, now, stateDir, timeoutMs: extra.timeoutMs, maxBytes: extra.maxBytes });
  return pc.check(command, { mode: 'online', lookup, allow: extra.allow, newDays: extra.newDays });
}

const NPM = (name) => 'https://registry.npmjs.org/' + name;
const PYPI = (name) => 'https://pypi.org/pypi/' + name + '/json';

test('404: the name is reported as not found, npm and PyPI', async () => {
  const f = fakeFetch({});
  const r = await online('npm i some-invented-name && pip install another-invented-name', f);
  assert.deepEqual(r.findings.map((x) => x.kind + ':' + x.name), ['not_found:some-invented-name', 'not_found:another-invented-name']);
  assert.deepEqual(f.calls.map((c) => c.url).sort(), [NPM('some-invented-name'), PYPI('another-invented-name')].sort());
});

test('200 with an old first release: nothing to say', async () => {
  const f = fakeFetch({ [NPM('old-thing')]: npmDoc(400), [PYPI('old-thing')]: pypiDoc(900, 30, 2) });
  const r = await online('npm i old-thing && pip install old-thing', f);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.unavailable, []);
});

test('200 with a recent first release: reported as new, with the days', async () => {
  const f = fakeFetch({ [NPM('fresh-thing')]: npmDoc(5), [PYPI('fresh-thing')]: pypiDoc(9, 3, 1) });
  const r = await online('npm i fresh-thing && pip install fresh-thing', f);
  assert.deepEqual(r.findings.map((x) => x.kind + ':' + x.eco + ':' + x.days), ['new_package:npm:5', 'new_package:pypi:9']);
});

test('PyPI: the first release is the oldest file of any release, not the latest one', async () => {
  const f = fakeFetch({ [PYPI('mixed-thing')]: pypiDoc(1, 400) });
  assert.deepEqual((await online('pip install mixed-thing', f)).findings, []);
});

test('the age limit: 14 days by default, and it can be changed', async () => {
  const f = () => fakeFetch({ [NPM('edge-thing')]: npmDoc(20) });
  assert.deepEqual((await online('npm i edge-thing', f())).findings, []);
  assert.equal((await online('npm i edge-thing', f(), { newDays: 30 })).findings.length, 1);
  const g = fakeFetch({ [NPM('edge-thing')]: npmDoc(13.5) });
  assert.equal((await online('npm i edge-thing', g)).findings.length, 1);
  const h = fakeFetch({ [NPM('edge-thing')]: npmDoc(14.5) });
  assert.equal((await online('npm i edge-thing', h)).findings.length, 0);
});

test('status 500, a redirect and a rejected fetch give no verdict and a note, never a finding', async () => {
  for (const [label, answer, why] of [
    ['500', { status: 500, body: 'boom' }, /status 500/],
    ['301', { status: 301, body: '' }, /status 301/],
    ['429', { status: 429, body: '' }, /status 429/],
    ['rejected', () => Promise.reject(new Error('ECONNRESET')), /ECONNRESET/],
    ['thrown', new Error('sync failure'), /sync failure/],
  ]) {
    const r = await online('npm i unknown-thing', fakeFetch({ [NPM('unknown-thing')]: answer }));
    assert.deepEqual(r.findings, [], label);
    assert.equal(r.unavailable.length, 1, label);
    assert.match(r.unavailable[0].why, why, label);
  }
});

test('a lookup that does not finish in time gives no verdict', async () => {
  const f = fakeFetch({ [NPM('slow-thing')]: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await online('npm i slow-thing', f, { timeoutMs: 40 });
  assert.ok(Date.now() - t0 < 1500);
  assert.deepEqual(r.findings, []);
  assert.match(r.unavailable[0].why, /timeout/);
});

test('malformed JSON, a body that is not an object and an empty reply give no verdict', async () => {
  for (const body of ['{not json', '[]', 'null', '"text"', '']) {
    const r = await online('npm i weird-thing', fakeFetch({ [NPM('weird-thing')]: { status: 200, body } }));
    assert.deepEqual(r.findings, [], JSON.stringify(body));
    assert.equal(r.unavailable.length, 1, JSON.stringify(body));
  }
  const noBody = await online('npm i weird-thing', fakeFetch({ [NPM('weird-thing')]: { status: 200 } }));
  assert.equal(noBody.unavailable.length, 1);
});

test('200 without a date: the name exists, so no "new" verdict', async () => {
  const f = fakeFetch({ [NPM('undated-thing')]: { status: 200, body: '{"name":"undated-thing"}' }, [PYPI('undated-thing')]: { status: 200, body: '{"releases":{}}' } });
  const r = await online('npm i undated-thing && pip install undated-thing', f);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.unavailable, []);
});

test('an unreadable date gives no "new" verdict', async () => {
  const f = fakeFetch({ [NPM('baddate-thing')]: { status: 200, body: '{"time":{"created":"yesterday-ish"}}' } });
  assert.deepEqual((await online('npm i baddate-thing', f)).findings, []);
});

test('a reply over the size cap is dropped', async () => {
  const f = fakeFetch({ [NPM('huge-thing')]: { status: 200, body: JSON.stringify({ time: { created: ago(1) }, pad: 'x'.repeat(5000) }) } });
  const r = await online('npm i huge-thing', f, { maxBytes: 1000 });
  assert.deepEqual(r.findings, []);
  assert.match(r.unavailable[0].why, /too large/);
  assert.equal(f.calls[0].options.maxBytes, 1000);
});

test('a scoped npm name is asked for as @scope%2Fname', async () => {
  const f = fakeFetch({});
  await online('npm i @some-scope/some-name', f);
  assert.deepEqual(f.calls.map((c) => c.url), ['https://registry.npmjs.org/@some-scope%2Fsome-name']);
});

test('only the package name is in the request: a fixed URL and two limits, nothing else', async () => {
  const f = fakeFetch({});
  await online('GITHUB_TOKEN=ghp_fake npm i some-invented-name --save-dev && echo secret@example.com', f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, NPM('some-invented-name'));
  assert.deepEqual(Object.keys(f.calls[0].options).sort(), ['maxBytes', 'timeoutMs']);
});

test('names are validated before they are put in a URL', () => {
  assert.equal(reg.urlFor('npm', 'lodash'), 'https://registry.npmjs.org/lodash');
  assert.equal(reg.urlFor('npm', '@a/b'), 'https://registry.npmjs.org/@a%2Fb');
  assert.equal(reg.urlFor('pypi', 'flask-cors'), 'https://pypi.org/pypi/flask-cors/json');
  for (const bad of ['', 'Upper', 'a b', 'a/b', '../x', 'a?b=1', 'a#b', '@a/b/c', '@/b', 'x'.repeat(215), 'a%2Fb', 'a\n', 'a:b@host']) assert.equal(reg.urlFor('npm', bad), null, bad);
  for (const bad of ['', 'Upper', 'a_b', 'a.b', 'a/b', '-a', 'a-', 'x'.repeat(101)]) assert.equal(reg.urlFor('pypi', bad), null, bad);
  assert.equal(reg.urlFor('gem', 'x'), null);
});

test('the real fetch refuses any host but the two registries and any scheme but https', async () => {
  for (const url of ['https://example.com/x', 'http://registry.npmjs.org/x', 'https://registry.npmjs.org.example.com/x', 'https://user:pw@pypi.org/pypi/x/json', 'not a url', 'file:///etc/passwd']) {
    await assert.rejects(() => reg.httpsFetch(url, { timeoutMs: 50 }), Error, url);
  }
});

test('names that cannot be looked up are not sent: capitals (legacy npm), well-known names, other registries', async () => {
  const f = fakeFetch({});
  const r = await online('npm i JSONStream react lodash && npm i internal-thing --registry https://registry.example.com && pip install internal-pkg --index-url https://pypi.example.com/simple', f);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(r.findings, []);
});

test('a look-alike is reported without a lookup, and the allow list silences even the lookup', async () => {
  const f = fakeFetch({});
  const r = await online('npm i lodsh allowed-invented', f, { allow: ['allowed-invented'] });
  assert.deepEqual(r.findings.map((x) => x.kind), ['one_edit']);
  assert.deepEqual(f.calls, []);
});

test('at most 8 names are looked up in one command', async () => {
  const f = fakeFetch({});
  await online('npm i ' + Array.from({ length: 12 }, (_, i) => 'invented-name-' + i).join(' '), f);
  assert.equal(f.calls.length, 8);
});

/* ---------------------------------- the cache ---------------------------------- */

test('cache: a second lookup within a day does not ask again; after a day it does', async (t) => {
  const stateDir = tempDir(t, 'zn-pkg-cache-');
  const f = fakeFetch({ [NPM('cached-thing')]: npmDoc(100) });
  const items = [{ eco: 'npm', name: 'cached-thing' }];
  const a = await reg.lookupMany(items, { fetch: f, now, stateDir });
  assert.equal(f.calls.length, 1);
  assert.equal(a.get('npm:cached-thing').state, 'found');
  const b = await reg.lookupMany(items, { fetch: f, now: () => NOW + 23 * 60 * 60 * 1000, stateDir });
  assert.equal(f.calls.length, 1, 'still fresh');
  assert.equal(b.get('npm:cached-thing').state, 'found');
  assert.ok(Math.abs(b.get('npm:cached-thing').ageDays - 100.958) < 0.01, 'age counted from the real first release');
  await reg.lookupMany(items, { fetch: f, now: () => NOW + 25 * 60 * 60 * 1000, stateDir });
  assert.equal(f.calls.length, 2, 'expired');
});

test('cache: a 404 is kept too, and a failure is not', async (t) => {
  const stateDir = tempDir(t, 'zn-pkg-cache-');
  const f = fakeFetch({ [NPM('gone-thing')]: { status: 404, body: '' }, [NPM('flaky-thing')]: { status: 500, body: '' } });
  const items = [{ eco: 'npm', name: 'gone-thing' }, { eco: 'npm', name: 'flaky-thing' }];
  await reg.lookupMany(items, { fetch: f, now, stateDir });
  await reg.lookupMany(items, { fetch: f, now, stateDir });
  assert.deepEqual(f.calls.map((c) => c.url), [NPM('gone-thing'), NPM('flaky-thing'), NPM('flaky-thing')]);
});

test('cache: the file holds only the name, the answer and two dates, is private, and replaces atomically', async (t) => {
  const stateDir = tempDir(t, 'zn-pkg-cache-');
  await reg.lookupMany([{ eco: 'npm', name: 'cached-thing' }], { fetch: fakeFetch({ [NPM('cached-thing')]: npmDoc(100) }), now, stateDir });
  const file = path.join(stateDir, reg.CACHE_FILE);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(data), ['v', 'e']);
  assert.deepEqual(Object.keys(data.e), ['npm:cached-thing']);
  assert.deepEqual(Object.keys(data.e['npm:cached-thing']).sort(), ['c', 's', 't']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(stateDir), [reg.CACHE_FILE], 'no temporary file is left');
});

test('cache: an unwritable folder is ignored (the lookup still answers), and so is a damaged file', async (t) => {
  const dir = tempDir(t, 'zn-pkg-cache-');
  const blocked = path.join(dir, 'a-file-not-a-folder');
  fs.writeFileSync(blocked, 'x');
  const f = fakeFetch({ [NPM('cached-thing')]: npmDoc(100) });
  const items = [{ eco: 'npm', name: 'cached-thing' }];
  const r = await reg.lookupMany(items, { fetch: f, now, stateDir: path.join(blocked, 'zn') });
  assert.equal(r.get('npm:cached-thing').state, 'found');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir);
  for (const junk of ['{not json', '{"v":2,"e":{}}', '{"v":1,"e":[]}', '{"v":1,"e":{"npm:cached-thing":{"t":"x","s":"found"}}}', '{"v":1,"e":{"npm:cached-thing":{"t":' + (NOW + DAY) + ',"s":"found"}}}']) {
    fs.writeFileSync(path.join(stateDir, reg.CACHE_FILE), junk);
    const before = f.calls.length;
    const again = await reg.lookupMany(items, { fetch: f, now, stateDir });
    assert.equal(again.get('npm:cached-thing').state, 'found', junk);
    assert.equal(f.calls.length, before + 1, 'a cache that cannot be trusted is asked again: ' + junk);
  }
});

test('cache: without a state folder nothing is read or written', async () => {
  const f = fakeFetch({ [NPM('x-thing')]: npmDoc(100) });
  await reg.lookupMany([{ eco: 'npm', name: 'x-thing' }], { fetch: f, now });
  await reg.lookupMany([{ eco: 'npm', name: 'x-thing' }], { fetch: f, now });
  assert.equal(f.calls.length, 2);
});

/* ------------------- the user's own registry settings ------------------- */

test('another registry in the settings: the public one is not asked', (t) => {
  const home = tempDir(t, 'zn-pkg-home-');
  const cwd = tempDir(t, 'zn-pkg-cwd-');
  const none = {};
  assert.equal(reg.privateRegistry('npm', { home, cwd, env: none }), false);
  assert.equal(reg.privateRegistry('pypi', { home, cwd, env: none }), false);
  assert.equal(reg.privateRegistry('npm', { home, cwd, env: { NPM_CONFIG_REGISTRY: 'https://npm.example.com' } }), true);
  assert.equal(reg.privateRegistry('pypi', { home, cwd, env: { PIP_INDEX_URL: 'https://pypi.example.com/simple' } }), true);
  assert.equal(reg.privateRegistry('pypi', { home, cwd, env: { UV_DEFAULT_INDEX: 'https://pypi.example.com/simple' } }), true);
  fs.writeFileSync(path.join(cwd, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  assert.equal(reg.privateRegistry('npm', { home, cwd, env: none }), false, 'the public registry named explicitly is still public');
  fs.writeFileSync(path.join(cwd, '.npmrc'), '@acme:registry=https://npm.example.com/\n');
  assert.equal(reg.privateRegistry('npm', { home, cwd, env: none }), true);
  fs.rmSync(path.join(cwd, '.npmrc'));
  fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://npm.example.com/\n');
  assert.equal(reg.privateRegistry('npm', { home, cwd, env: none }), true);
  fs.mkdirSync(path.join(home, '.config', 'pip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'pip', 'pip.conf'), '[global]\nindex-url = https://pypi.example.com/simple\n');
  assert.equal(reg.privateRegistry('pypi', { home, cwd, env: none }), true);
  fs.rmSync(path.join(home, '.config'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'pyproject.toml'), '[[tool.uv.index]]\nname = "x"\nurl = "https://pypi.example.com/simple"\n');
  assert.equal(reg.privateRegistry('pypi', { home, cwd, env: none }), true);
  assert.equal(reg.privateRegistry('npm', { home: path.join(home, 'nope'), cwd: path.join(cwd, 'nope'), env: none }), false, 'missing folders are fine');
});

test('createdOf: npm and PyPI shapes', () => {
  assert.equal(reg.createdOf('npm', { time: { created: '2020-01-01T00:00:00.000Z' } }), Date.UTC(2020, 0, 1));
  assert.equal(reg.createdOf('npm', {}), null);
  assert.equal(reg.createdOf('pypi', { releases: { '1': [{ upload_time: '2021-02-03T04:05:06' }], '2': [{ upload_time_iso_8601: '2022-01-01T00:00:00.000000Z' }] } }), Date.UTC(2021, 1, 3, 4, 5, 6));
  assert.equal(reg.createdOf('pypi', { releases: { '1': [] } }), null);
  assert.equal(reg.createdOf('pypi', { releases: 'x' }), null);
});
