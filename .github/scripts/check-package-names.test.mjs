// Tests of the pure parts of check-package-names.mjs. No network: the fetcher is fake.
// Run: node --test .github/scripts/check-package-names.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyResults, classify, firstReleaseOf, parseArgs, urlFor, verifyNames } from './check-package-names.mjs';

const NOW = Date.UTC(2026, 10, 5);
const DAY = 24 * 60 * 60 * 1000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const npmReply = (d) => ({ status: 200, body: JSON.stringify({ time: { created: ago(d) } }) });
const pypiReply = (...ds) => ({ status: 200, body: JSON.stringify({ releases: Object.fromEntries(ds.map((d, i) => ['1.' + i, [{ upload_time_iso_8601: ago(d) }]])) }) });

test('urlFor builds registry URLs only for valid names', () => {
  assert.equal(urlFor('npm', '@types/node'), 'https://registry.npmjs.org/@types%2Fnode');
  assert.equal(urlFor('pypi', 'zope-interface'), 'https://pypi.org/pypi/zope-interface/json');
  assert.equal(urlFor('npm', '../x'), null);
  assert.equal(urlFor('pypi', 'Bad_Name'), null);
  assert.equal(urlFor('gem', 'x'), null);
});

test('firstReleaseOf: npm time.created and the earliest PyPI upload', () => {
  assert.equal(firstReleaseOf('npm', { time: { created: ago(10) } }), NOW - 10 * DAY);
  assert.equal(firstReleaseOf('pypi', JSON.parse(pypiReply(5, 900, 30).body)), NOW - 900 * DAY);
  assert.equal(firstReleaseOf('pypi', { releases: {} }), null);
  assert.equal(firstReleaseOf('npm', {}), null);
});

test('classify: ok, young, missing and the error cases', () => {
  assert.equal(classify('npm', npmReply(800), NOW, 365).state, 'ok');
  assert.deepEqual(classify('npm', npmReply(100), NOW, 365), { state: 'young', ageDays: 100 });
  assert.equal(classify('npm', npmReply(365), NOW, 365).state, 'ok');
  assert.equal(classify('pypi', { status: 404, body: '' }, NOW, 365).state, 'missing');
  assert.equal(classify('pypi', { status: 503, body: '' }, NOW, 365).state, 'error');
  assert.equal(classify('pypi', { status: 200, body: 'nope' }, NOW, 365).state, 'error');
  assert.equal(classify('pypi', { status: 200, body: '{}' }, NOW, 365).state, 'error');
  assert.equal(classify('npm', undefined, NOW, 365).state, 'error');
});

test('verifyNames: one at a time, in order, with one retry for an error', async () => {
  const calls = [];
  let flaky = 0;
  const fetch = async (url, o) => {
    calls.push(url + '|' + o.maxBytes);
    if (url.endsWith('/old')) return npmReply(900);
    if (url.endsWith('/young')) return npmReply(10);
    if (url.endsWith('/gone')) return { status: 404, body: '' };
    if (url.endsWith('/flaky')) { if (flaky++ === 0) throw new Error('timeout'); return npmReply(900); }
    if (url.endsWith('/huge')) { if (o.maxBytes <= 4 * 1024 * 1024) throw new Error('too large'); return npmReply(900); }
    throw new Error('network down');
  };
  const items = ['old', 'young', 'gone', 'flaky', 'huge', 'down'].map((name) => ({ eco: 'npm', name }));
  const res = await verifyNames(items, { fetch, now: NOW, minDays: 365, pauseMs: 0, sleep: async () => {} });
  assert.deepEqual(res.map((r) => r.name + ':' + r.state), ['old:ok', 'young:young', 'gone:missing', 'flaky:ok', 'huge:ok', 'down:error']);
  assert.equal(res[5].retried, true);
  assert.equal(calls.filter((c) => c.includes('/down')).length, 2);
  assert.equal(calls.filter((c) => c.includes('/gone')).length, 1);
});

test('applyResults drops every name that is not ok, keeps the lists sorted and counts', () => {
  const list = { description: 'd', npm: ['b', 'a', 'c'], pypi: ['x', 'y'] };
  const results = [
    { eco: 'npm', name: 'b', state: 'ok' }, { eco: 'npm', name: 'a', state: 'young' }, { eco: 'npm', name: 'c', state: 'error' },
    { eco: 'pypi', name: 'x', state: 'missing' }, { eco: 'pypi', name: 'y', state: 'ok' },
  ];
  const { list: next, counts } = applyResults(list, results);
  assert.deepEqual(next.npm, ['b']);
  assert.deepEqual(next.pypi, ['y']);
  assert.equal(next.description, 'd');
  assert.deepEqual(counts, { checked: 5, dropped: 3, missing: 1, young: 1, errors: 1 });
});

test('parseArgs: defaults, flags and bad input', () => {
  assert.equal(parseArgs([]).minDays, 365);
  const o = parseArgs(['--min-days', '30', '--write', '--add', 'pypi:motor', '--report', 'r.json']);
  assert.deepEqual([o.minDays, o.write, o.extra, o.report], [30, true, ['pypi:motor'], 'r.json']);
  assert.throws(() => parseArgs(['--nope']));
  assert.throws(() => parseArgs(['--min-days', 'x']));
});
