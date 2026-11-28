// Tests of check-scheduled-failure-alerts.mjs. Run: node --test .github/scripts/check-scheduled-failure-alerts.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALERT_JOB, checkDir, checkWorkflow, RUN_URL_VALUE } from './check-scheduled-failure-alerts.mjs';

const DEFAULT_IF = "always() && github.event_name == 'schedule' && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled'))";

/* Builds a workflow file. Each option replaces one part of the good fixture. */
function workflow(opts = {}) {
  const {
    onSchedule = true,
    topPerms = ['permissions:', '  contents: read'],
    jobs = ['check', 'lint'],
    jobPerms = {},
    withAlert = true,
    needsLines = ['    needs: [check, lint]'],
    ifExpr = DEFAULT_IF,
    alertPerms = ['      contents: read', '      issues: write'],
    alertEnv = [],
    runUrl = RUN_URL_VALUE,
  } = opts;
  const lines = ['# Runs the checks on a schedule.', 'name: Checks', 'on:', '  push:'];
  if (onSchedule) lines.push('  schedule:', "    - cron: '30 6 * * *'");
  lines.push('  workflow_dispatch:', ...topPerms, 'jobs:');
  for (const j of jobs) {
    lines.push(`  ${j}:`, '    runs-on: ubuntu-latest', '    timeout-minutes: 5');
    if (jobPerms[j]) {
      // A single entry that starts with "{" is written inline (flow map), otherwise as a block.
      if (jobPerms[j][0].startsWith('{')) lines.push(`    permissions: ${jobPerms[j][0]}`);
      else lines.push('    permissions:', ...jobPerms[j]);
    }
    lines.push('    steps:', '      - run: echo ok');
  }
  if (withAlert) {
    lines.push(
      `  ${ALERT_JOB}:`,
      '    name: open or update the scheduled failure issue',
      `    if: ${ifExpr}`,
      ...needsLines,
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 5',
      '    permissions:',
      ...alertPerms,
      '    env:',
      '      GH_TOKEN: ${{ github.token }}',
      '      GH_REPO: ${{ github.repository }}',
      ...alertEnv,
    );
    if (runUrl !== null) lines.push(`      RUN_URL: ${runUrl}`);
    lines.push('    steps:', '      - name: Open or update the failure issue', '        run: echo "$RUN_URL"');
  }
  return lines.join('\n') + '\n';
}

function problemsOf(text) {
  return checkWorkflow(text).problems;
}

function mentions(problems, word) {
  return problems.some((p) => p.includes(word));
}

test('a scheduled workflow with a complete alert job passes', () => {
  const r = checkWorkflow(workflow());
  assert.equal(r.scheduled, true);
  assert.equal(r.hasAlert, true);
  assert.deepEqual(r.problems, []);
});

test('a block-style needs list that names every job passes', () => {
  const text = workflow({ needsLines: ['    needs:', '      - check', '      - lint'] });
  assert.deepEqual(problemsOf(text), []);
});

test('a workflow without a schedule trigger is not checked, even without the alert job', () => {
  const r = checkWorkflow(workflow({ onSchedule: false, withAlert: false }));
  assert.equal(r.scheduled, false);
  assert.deepEqual(r.problems, []);
});

test('a scheduled workflow without the alert job reports hasAlert false, not a problem of its own', () => {
  const r = checkWorkflow(workflow({ withAlert: false }));
  assert.equal(r.scheduled, true);
  assert.equal(r.hasAlert, false);
  assert.deepEqual(r.problems, []);
});

test('a missing need fails and names the job', () => {
  const problems = problemsOf(workflow({ needsLines: ['    needs: [check]'] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /needs does not list: lint/);
});

test('a missing need in block form fails', () => {
  const problems = problemsOf(workflow({ needsLines: ['    needs:', '      - check'] }));
  assert.match(problems.join('\n'), /needs does not list: lint/);
});

test('a need that names no job of the workflow fails', () => {
  const problems = problemsOf(workflow({ needsLines: ['    needs: [check, lint, scope]'] }));
  assert.match(problems.join('\n'), /does not exist: scope/);
});

const IF_MSG = /approved forms/;

test('the approved if with the repository guard passes', () => {
  assert.deepEqual(problemsOf(workflow({ ifExpr: DEFAULT_IF })), []);
});

test('the approved if without the repository guard passes', () => {
  const ifExpr = "always() && github.event_name == 'schedule' && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled'))";
  assert.deepEqual(problemsOf(workflow({ ifExpr })), []);
});

test('extra spacing inside the parentheses does not change the approved if', () => {
  const ifExpr = "always() && github.event_name == 'schedule' && (  contains(needs.*.result, 'failure') ||  contains(needs.*.result, 'cancelled') )";
  assert.deepEqual(problemsOf(workflow({ ifExpr })), []);
});

test('false && in front of an approved if fails: the job would never fire', () => {
  assert.match(problemsOf(workflow({ ifExpr: `false && ${DEFAULT_IF}` })).join('\n'), IF_MSG);
});

test('true || in front of an approved if fails: the job would fire without a failed job', () => {
  assert.match(problemsOf(workflow({ ifExpr: `true || ${DEFAULT_IF}` })).join('\n'), IF_MSG);
});

test('an if without cancelled fails', () => {
  const ifExpr = "always() && github.event_name == 'schedule' && contains(needs.*.result, 'failure')";
  assert.match(problemsOf(workflow({ ifExpr })).join('\n'), IF_MSG);
});

test('an if without failure fails', () => {
  const ifExpr = "always() && github.event_name == 'schedule' && contains(needs.*.result, 'cancelled')";
  assert.match(problemsOf(workflow({ ifExpr })).join('\n'), IF_MSG);
});

test('failure and cancelled joined with && instead of || fails', () => {
  const ifExpr = "always() && github.event_name == 'schedule' && contains(needs.*.result, 'failure') && contains(needs.*.result, 'cancelled')";
  assert.match(problemsOf(workflow({ ifExpr })).join('\n'), IF_MSG);
});

test('an if without always() fails', () => {
  const ifExpr = "github.event_name == 'schedule' && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled'))";
  assert.match(problemsOf(workflow({ ifExpr })).join('\n'), IF_MSG);
});

test('an if without the schedule guard fails', () => {
  const ifExpr = "always() && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled'))";
  assert.match(problemsOf(workflow({ ifExpr })).join('\n'), IF_MSG);
});

test('a flow-style read-only permissions map passes at both levels', () => {
  const text = workflow({ topPerms: ['permissions: {contents: read}'], jobPerms: { check: ['{contents: read}'] } });
  assert.deepEqual(problemsOf(text), []);
});

test('issues: write in a workflow-level flow map fails', () => {
  const problems = problemsOf(workflow({ topPerms: ['permissions: {contents: read, issues: write}'] }));
  assert.match(problems.join('\n'), /workflow-level permissions grant write/);
});

test('issues: write in another job flow map fails and names that job', () => {
  const problems = problemsOf(workflow({ jobPerms: { lint: ['{contents: read, issues: write}'] } }));
  assert.match(problems.join('\n'), /job "lint" grants issues: write/);
});

test('an alert job flow map without issues: write fails', () => {
  const problems = problemsOf(workflow({ alertPerms: ['      contents: read'] }));
  assert.match(problems.join('\n'), /needs issues: write/);
});

test('a permissions form that cannot be read fails at workflow level and on a job', () => {
  assert.match(problemsOf(workflow({ topPerms: ['permissions: some-odd-form'] })).join('\n'), /use a block map/);
  assert.match(problemsOf(workflow({ jobPerms: { check: ['{contents: read, issues write}'] } })).join('\n'), /cannot be read/);
});

test('an alert job without issues: write fails', () => {
  const problems = problemsOf(workflow({ alertPerms: ['      contents: read'] }));
  assert.match(problems.join('\n'), /needs issues: write/);
});

test('issues: write at workflow level fails and names the workflow level', () => {
  const problems = problemsOf(workflow({ topPerms: ['permissions:', '  contents: read', '  issues: write'] }));
  assert.match(problems.join('\n'), /workflow-level permissions grant write/);
});

test('write-all at workflow level fails', () => {
  const problems = problemsOf(workflow({ topPerms: ['permissions: write-all'] }));
  assert.match(problems.join('\n'), /workflow-level permissions grant write/);
});

test('issues: write on another job fails and names that job', () => {
  const problems = problemsOf(workflow({ jobPerms: { check: ['      contents: read', '      issues: write'] } }));
  assert.match(problems.join('\n'), /job "check" grants issues: write/);
});

test('an untrusted expression in the alert job fails', () => {
  const alertEnv = ['      TITLE: ${{ github.event.pull_request.title }}'];
  assert.match(problemsOf(workflow({ alertEnv })).join('\n'), /interpolates \$\{\{ github\.event\.pull_request\.title \}\}/);
});

test('a run link built from the event payload fails', () => {
  const runUrl = '${{ github.event.repository.html_url }}/actions/runs/${{ github.run_id }}';
  assert.match(problemsOf(workflow({ runUrl })).join('\n'), /RUN_URL must be the run link/);
});

test('an alert job without a RUN_URL fails', () => {
  assert.match(problemsOf(workflow({ runUrl: null })).join('\n'), /RUN_URL must be the run link/);
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'schedalert-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('checkDir lists a scheduled workflow without the job as lacking it', () => {
  const dir = tree({ 'old.yml': workflow({ withAlert: false }), 'plain.yml': workflow({ onSchedule: false, withAlert: false }) });
  const r = checkDir(dir, []);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.scheduled, ['old.yml']);
  assert.deepEqual(r.lacking, ['old.yml']);
  assert.deepEqual(r.problems, []);
});

test('checkDir reports a pending workflow without failing it', () => {
  const dir = tree({ 'old.yml': workflow({ withAlert: false }) });
  const r = checkDir(dir, ['old.yml']);
  assert.deepEqual(r.pending, ['old.yml']);
  assert.deepEqual(r.lacking, []);
  assert.deepEqual(r.stale, []);
});

test('checkDir marks a pending entry stale once the job exists or the file is gone', () => {
  const dir = tree({ 'good.yml': workflow() });
  assert.deepEqual(checkDir(dir, ['good.yml']).stale, ['good.yml']);
  assert.deepEqual(checkDir(dir, ['gone.yml']).stale, ['gone.yml']);
});

test('checkDir reports the file of a bad alert job', () => {
  const dir = tree({ 'bad.yml': workflow({ needsLines: ['    needs: [check]'] }) });
  const r = checkDir(dir, []);
  assert.deepEqual(r.problems.map((p) => p.file), ['bad.yml']);
});

test('the workflows of this repository pass the check', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
  const r = checkDir(dir);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.lacking, []);
  assert.deepEqual(r.stale, []);
});
