// Tests for release-required-checks.mjs: run with `node --test .github/scripts/release-required-checks.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LIST, DEFAULT_WORKFLOWS, parseList, jobNames, templateRegex, lint, parseRows, verify,
} from './release-required-checks.mjs';

const REQUIRED = ['A tests', 'B (ubuntu-latest)', 'Public facts'];
const row = (name, conclusion = 'success', status = 'completed', app = 'github-actions') => [name, status, conclusion, app].join('\t');
const tsv = (...rows) => rows.join('\n') + '\n';

test('the list file parses and has no duplicates', () => {
  const names = parseList(readFileSync(DEFAULT_LIST, 'utf8'));
  assert.ok(names.length >= 8);
  assert.equal(new Set(names).size, names.length);
});

test('every name in the real list matches a job name in the real workflows (a renamed job breaks here)', () => {
  const required = parseList(readFileSync(DEFAULT_LIST, 'utf8'));
  const texts = readdirSync(DEFAULT_WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).map((f) => readFileSync(path.join(DEFAULT_WORKFLOWS, f), 'utf8'));
  assert.deepEqual(lint(required, texts), []);
});

test('the real list covers the checks of the rulesets', () => {
  const required = parseList(readFileSync(DEFAULT_LIST, 'utf8'));
  for (const n of ['Public facts', 'Lint (eslint, ruff, mypy)', 'build, test, clippy, fmt', 'Node.js 18.x tests & benchmarks']) {
    assert.ok(required.includes(n), n);
  }
});

test('parseList drops comments and blank lines, and refuses an empty or duplicated list', () => {
  assert.deepEqual(parseList('# c\n\nA\nB # note\r\n'), ['A', 'B']);
  assert.throws(() => parseList('# only a comment\n'), /empty/);
  assert.throws(() => parseList('A\nA\n'), /twice/);
});

test('jobNames reads names, falls back to the job id, and expands nothing', () => {
  const wf = [
    'name: x', 'on: push', 'jobs:',
    '  one:', '    name: First job', '    runs-on: ubuntu-latest',
    '  two:', '    runs-on: ubuntu-latest', '    steps:', '      - name: not a job name',
    '  three:', '    name: "Matrix ${{ matrix.v }} (${{ matrix.os }})"  # c',
    'env:', '  name: nope',
  ].join('\n');
  assert.deepEqual(jobNames(wf), ['First job', 'two', 'Matrix ${{ matrix.v }} (${{ matrix.os }})']);
});

test('templateRegex matches matrix expansions exactly and nothing else', () => {
  const r = templateRegex('Node.js ${{ matrix.node-version }} tests & benchmarks');
  assert.ok(r.test('Node.js 18.x tests & benchmarks'));
  assert.ok(!r.test('Node.js tests & benchmarks'));
  assert.ok(!r.test('xNode.js 18.x tests & benchmarks!'));
  assert.ok(templateRegex('build, test, clippy, fmt').test('build, test, clippy, fmt'));
  assert.ok(!templateRegex('Public facts').test('Public facts 2'));
});

test('lint reports a required name no job produces', () => {
  const wf = 'jobs:\n  a:\n    name: A tests\n';
  const errors = lint(['A tests', 'Renamed job'], [wf]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Renamed job/);
});

test('verify passes when every required check succeeded and nothing else failed', () => {
  const rows = parseRows(tsv(row('A tests'), row('B (ubuntu-latest)'), row('Public facts'), row('Extra', 'skipped'), row('More', 'neutral')));
  assert.deepEqual(verify(REQUIRED, rows), []);
});

test('verify fails when no check ran', () => {
  assert.match(verify(REQUIRED, parseRows('')).join('\n'), /no checks ran/);
});

test('verify fails on a missing required check even when every other check passed', () => {
  const errors = verify(REQUIRED, parseRows(tsv(row('A tests'), row('B (ubuntu-latest)'), row('Unrelated'))));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing: Public facts/);
});

test('verify does not accept skipped or neutral for a required check', () => {
  for (const c of ['skipped', 'neutral']) {
    const errors = verify(REQUIRED, parseRows(tsv(row('A tests'), row('B (ubuntu-latest)'), row('Public facts', c))));
    assert.ok(errors.some((e) => /did not succeed: Public facts/.test(e)), c);
  }
});

test('verify needs the exact matrix name', () => {
  const errors = verify(REQUIRED, parseRows(tsv(row('A tests'), row('B (windows-latest)'), row('Public facts'))));
  assert.ok(errors.some((e) => /missing: B \(ubuntu-latest\)/.test(e)));
});

test('verify still rejects any failing, cancelled or unfinished run, required or not', () => {
  const base = [row('A tests'), row('B (ubuntu-latest)'), row('Public facts')];
  assert.ok(verify(REQUIRED, parseRows(tsv(...base, row('Other', 'failure')))).length > 0);
  assert.ok(verify(REQUIRED, parseRows(tsv(...base, row('Other', 'cancelled')))).length > 0);
  assert.ok(verify(REQUIRED, parseRows(tsv(...base, row('Other', '', 'in_progress')))).length > 0);
  assert.ok(verify(REQUIRED, parseRows(tsv(...base, row('Other', 'timed_out')))).length > 0);
});

test('verify requires the check to come from GitHub Actions', () => {
  const errors = verify(REQUIRED, parseRows(tsv(row('A tests'), row('B (ubuntu-latest)'), row('Public facts', 'success', 'completed', 'some-other-app'))));
  assert.ok(errors.some((e) => /did not succeed: Public facts/.test(e)));
});

test('verify accepts a rerun: one failed run of a required name does not hide a later success, but the failure still blocks', () => {
  const rows = parseRows(tsv(row('A tests', 'failure'), row('A tests'), row('B (ubuntu-latest)'), row('Public facts')));
  const errors = verify(REQUIRED, rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A tests \(completed\/failure\)/);
});
