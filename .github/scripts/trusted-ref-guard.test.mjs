// Tests of trusted-ref-guard.mjs. Run: node --test .github/scripts/trusted-ref-guard.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, labelApproved, protectedChanges, reviewApproved } from './trusted-ref-guard.mjs';

const approvers = ['maintainer'];
const base = { files: [], events: [], labels: [], reviews: [], headSha: 'abc', approvers };

test('only protected paths are listed', () => {
  assert.deepEqual(protectedChanges(['README.md', 'src/main.rs', '.github/pull_request_template.md']), []);
  assert.deepEqual(
    protectedChanges(['.github/workflows/ci.yml', '.github/scripts/ci-scope.sh', '.github/scripts/check-docs-fences.mjs', 'scripts/verify-release.sh']),
    ['.github/workflows/ci.yml', '.github/scripts/ci-scope.sh', 'scripts/verify-release.sh'],
  );
});

test('a pull request that touches no protected file passes', () => {
  assert.equal(decide({ ...base, files: ['docs/cli.md'] }).ok, true);
});

test('a protected change with no approval fails and names the file', () => {
  const r = decide({ ...base, files: ['.github/workflows/rust.yml'] });
  assert.equal(r.ok, false);
  assert.match(r.message, /\.github\/workflows\/rust\.yml/);
});

test('the label counts only when an approver applied it and it is still on the pull request', () => {
  const ev = [{ event: 'labeled', label: { name: 'ci-change' }, actor: { login: 'Maintainer' } }];
  assert.equal(labelApproved(ev, ['ci-change'], approvers), true);
  assert.equal(labelApproved(ev, [], approvers), false);
  const other = [{ event: 'labeled', label: { name: 'ci-change' }, actor: { login: 'author' } }];
  assert.equal(labelApproved(other, ['ci-change'], approvers), false);
  // The author re-applies the label after an approver removed it: the newest event decides.
  const reapplied = [...ev, { event: 'unlabeled', label: { name: 'ci-change' }, actor: { login: 'maintainer' } },
    { event: 'labeled', label: { name: 'ci-change' }, actor: { login: 'author' } }];
  assert.equal(labelApproved(reapplied, ['ci-change'], approvers), false);
});

test('a review counts only for the current head commit and only the latest state of each approver', () => {
  const ok = [{ user: { login: 'maintainer' }, state: 'APPROVED', commit_id: 'abc' }];
  assert.equal(reviewApproved(ok, 'abc', approvers), true);
  assert.equal(reviewApproved(ok, 'def', approvers), false);
  const changed = [...ok, { user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', commit_id: 'abc' }];
  assert.equal(reviewApproved(changed, 'abc', approvers), false);
  const stranger = [{ user: { login: 'author' }, state: 'APPROVED', commit_id: 'abc' }];
  assert.equal(reviewApproved(stranger, 'abc', approvers), false);
});

test('a protected change passes with an approved label or review', () => {
  const files = ['.github/scripts/ci-scope.sh'];
  const events = [{ event: 'labeled', label: { name: 'ci-change' }, actor: { login: 'maintainer' } }];
  assert.equal(decide({ ...base, files, events, labels: ['ci-change'] }).ok, true);
  assert.equal(decide({ ...base, files, reviews: [{ user: { login: 'maintainer' }, state: 'APPROVED', commit_id: 'abc' }] }).ok, true);
});
