// Tests of check-heavy-jobs-gating.mjs. Run: node --test .github/scripts/check-heavy-jobs-gating.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HEAVY, LIGHT, REQUIRED, SCENARIOS, check, evalExpr, jobRuns, jobsOf, mgCtx, prCtx, pushCtx } from './check-heavy-jobs-gating.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (e, ctx) => jobRuns(e, { github: ctx });

test('the evaluator handles the operators and functions the workflows use', () => {
  const g = { github: prCtx('next', ['full-ci']) };
  assert.equal(evalExpr("${{ github.event_name == 'pull_request' }}", g), true);
  assert.equal(evalExpr("github.base_ref != 'next' || contains(github.event.pull_request.labels.*.name, 'full-ci')", g), true);
  assert.equal(evalExpr("!(github.event_name == 'push') && startsWith(github.base_ref, 'ne')", g), true);
  assert.equal(evalExpr('github.event.pull_request.draft == false', g), true);
  assert.equal(evalExpr("contains(github.event.pull_request.labels.*.name, 'other')", g), false);
  assert.throws(() => evalExpr("fromJSON('[1]')", g), /not supported/);
});

test('a job without an if always runs', () => {
  assert.equal(run(null, prCtx('next')), true);
});

test('a heavy if is skipped without the label and runs with it, in the queue and on push', () => {
  const heavy = "${{ !(github.event_name == 'push' && github.ref == 'refs/heads/next') && (github.event_name != 'pull_request' || (github.event.pull_request.draft == false && (github.base_ref != 'next' || contains(github.event.pull_request.labels.*.name, 'full-ci')))) }}";
  assert.equal(run(heavy, prCtx('next')), false);
  assert.equal(run(heavy, prCtx('next', ['full-ci'])), true);
  assert.equal(run(heavy, mgCtx('next')), true);
  assert.equal(run(heavy, pushCtx('main')), true);
  assert.equal(run(heavy, pushCtx('next')), false);
  assert.equal(run(heavy, prCtx('main')), true);
});

test('the jobs of a workflow are read with their names and conditions', () => {
  const text = "name: x\njobs:\n  a:\n    name: Alpha\n    if: github.event_name == 'push'\n    runs-on: x\n  b:\n    name: Beta ${{ matrix.v }}\n";
  assert.deepEqual(jobsOf(text), [
    { id: 'a', name: 'Alpha', if: "github.event_name == 'push'" },
    { id: 'b', name: 'Beta ${{ matrix.v }}', if: null },
  ]);
});

test('the repository: heavy jobs skip without the label, run with it and in the merge queue, light jobs always run', () => {
  assert.deepEqual(check(root), []);
});

test('the scenarios cover the pull request, label, merge queue, push and schedule cases', () => {
  const labels = SCENARIOS.map((s) => s.label).join('|');
  for (const word of ['no label', 'label full-ci', 'merge queue', 'push to main', 'release branch', 'schedule', 'draft']) {
    assert.ok(labels.includes(word), word);
  }
  assert.equal(REQUIRED.length, 11);
  assert.equal(HEAVY.length, 5);
  assert.equal(LIGHT.length, 3);
});

function copyRepoParts() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-gating-'));
  fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true });
  for (const f of fs.readdirSync(path.join(root, '.github', 'workflows'))) {
    fs.copyFileSync(path.join(root, '.github', 'workflows', f), path.join(tmp, '.github', 'workflows', f));
  }
  fs.copyFileSync(path.join(root, 'CONTRIBUTING.md'), path.join(tmp, 'CONTRIBUTING.md'));
  fs.copyFileSync(path.join(root, '.github', 'release-required-checks.txt'), path.join(tmp, '.github', 'release-required-checks.txt'));
  return tmp;
}

test('a heavy job that loses its label condition is reported', () => {
  const tmp = copyRepoParts();
  try {
    const f = path.join(tmp, '.github', 'workflows', 'rust.yml');
    const t = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, t.replace(/\n    if: \$\{\{ !\(github\.event_name == 'push'.*\n/, "\n    if: github.event_name != 'merge_group' || true\n"));
    const problems = check(tmp);
    assert.ok(problems.some((p) => p.includes('build, test, clippy, fmt') && p.includes('pull request into next, no label')), problems.join('\n'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a matrix name in place of a literal name is reported', () => {
  const tmp = copyRepoParts();
  try {
    const f = path.join(tmp, '.github', 'workflows', 'ci.yml');
    const t = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, t.replace('    name: Node.js 22.x tests & benchmarks\n', '    name: Node.js ${{ matrix.node-version }} tests & benchmarks\n'));
    assert.ok(check(tmp).some((p) => p.includes('"Node.js 22.x tests & benchmarks"')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a workflow that gates on the label but ignores the unlabeled event is reported', () => {
  const tmp = copyRepoParts();
  try {
    const f = path.join(tmp, '.github', 'workflows', 'ci.yml');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('labeled, unlabeled, ready_for_review', 'labeled, ready_for_review'));
    assert.ok(check(tmp).some((p) => p.startsWith('ci.yml') && p.includes('"unlabeled"')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a concurrency group without the pull request number is reported', () => {
  const tmp = copyRepoParts();
  try {
    const f = path.join(tmp, '.github', 'workflows', 'rust.yml');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('group: rust-${{ github.event.pull_request.number ||', 'group: rust-${{ github.ref ||'));
    assert.ok(check(tmp).some((p) => p.startsWith('rust.yml') && p.includes('pull request number')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
