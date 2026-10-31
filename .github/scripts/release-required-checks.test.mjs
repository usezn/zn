// Tests for release-required-checks.mjs: run with `node --test .github/scripts/release-required-checks.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LIST, DEFAULT_WORKFLOWS, parseList, jobNames, templateRegex, lint, lintDedupe, dedupeSkippable, jobDefs, parseRows, verify,
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

const DEDUPE_JOB = [
  '  dedupe:', '    name: Release push dedupe', "    if: github.event_name == 'push'", '    uses: ./.github/workflows/release-push-dedupe.yml',
];
const wfWith = (...jobLines) => ['name: x', 'on: push', 'jobs:', ...DEDUPE_JOB, ...jobLines, ''].join('\n');

test('jobDefs reads needs in every YAML form', () => {
  const wf = [
    'jobs:',
    '  a:', '    name: A', '    needs: dedupe', '    runs-on: x',
    '  b:', '    needs: [dedupe, a]  # c', '    runs-on: x',
    '  c:', '    needs:', '      - a', '      - b # c', '    runs-on: x',
  ].join('\n');
  const jobs = Object.fromEntries(jobDefs(wf).map((j) => [j.id, j.needs]));
  assert.deepEqual(jobs, { a: ['dedupe'], b: ['dedupe', 'a'], c: ['a', 'b'] });
});

test('the real workflows: no job that the release push dedupe can skip carries a required name', () => {
  const required = parseList(readFileSync(DEFAULT_LIST, 'utf8'));
  const texts = readdirSync(DEFAULT_WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).map((f) => readFileSync(path.join(DEFAULT_WORKFLOWS, f), 'utf8'));
  assert.deepEqual(lintDedupe(required, texts), []);
  // the dedupe is still wired somewhere, so this test cannot pass by finding nothing
  assert.ok(texts.some((t) => dedupeSkippable(t).length > 1));
});

test('lintDedupe passes a matrix job behind the dedupe: its skipped name is the unexpanded template', () => {
  const wf = wfWith('  t:', '    name: Node.js ${{ matrix.v }} tests', '    needs: dedupe', "    if: ${{ needs.dedupe.outputs.skip != 'true' }}");
  assert.deepEqual(lintDedupe(['Node.js 18.x tests', 'Public facts'], [wf]), []);
});

test('lintDedupe fails a job under a required name that needs the dedupe job', () => {
  const wf = wfWith('  lint:', '    name: Lint (x)', '    needs: dedupe', '    runs-on: x');
  const errors = lintDedupe(['Lint (x)'], [wf]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"Lint \(x\)".*job "lint"/);
});

test('lintDedupe fails on needs in list form and flow form, and on a job named by its id', () => {
  for (const needs of ['    needs: [dedupe]', '    needs:\n      - dedupe']) {
    const wf = wfWith('  lint:', '    name: Lint (x)', needs, '    runs-on: x');
    assert.equal(lintDedupe(['Lint (x)'], [wf]).length, 1, needs);
  }
  const noName = wfWith('  Public-facts:', '    needs: dedupe', '    runs-on: x');
  assert.equal(lintDedupe(['Public-facts'], [noName]).length, 1);
});

test('lintDedupe fails when a required job only reads the dedupe output in an if: or an env, without listing it in needs', () => {
  const inIf = wfWith('  lint:', '    name: Lint (x)', "    if: ${{ needs.dedupe.outputs.skip != 'true' }}", '    runs-on: x');
  assert.equal(lintDedupe(['Lint (x)'], [inIf]).length, 1);
  const inEnv = wfWith('  lint:', '    name: Lint (x)', '    runs-on: x', '    env:', '      S: ${{ needs.dedupe.outputs.skip }}');
  assert.equal(lintDedupe(['Lint (x)'], [inEnv]).length, 1);
});

test('lintDedupe follows needs through another job (a job that needs a skipped job is skipped too)', () => {
  const wf = wfWith('  scope:', '    name: Scope', '    needs: dedupe', '  lint:', '    name: Lint (x)', '    needs: scope');
  assert.equal(lintDedupe(['Lint (x)'], [wf]).length, 1);
});

test('lintDedupe ignores a workflow without a dedupe job and a job that does not depend on it', () => {
  assert.deepEqual(lintDedupe(['Lint (x)'], ['jobs:\n  lint:\n    name: Lint (x)\n    needs: other\n']), []);
  assert.deepEqual(lintDedupe(['Lint (x)'], [wfWith('  lint:', '    name: Lint (x)', '    runs-on: x')]), []);
});

test('lint reports the dedupe collision together with the other errors', () => {
  const wf = wfWith('  lint:', '    name: Lint (x)', '    needs: dedupe');
  const errors = lint(['Lint (x)', 'Missing'], [wf]);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /Missing/.test(e)) && errors.some((e) => /dedupe can skip/.test(e)));
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
