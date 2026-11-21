'use strict';

// Edge cases of syncOutcome (lib/team/sync-outcome.js): missing or malformed results, every policy and
// upload status, the pending-record count, and how odd text in a status or error is cleaned up.
// It is a pure function, so these tests only build plain objects with made-up values.

const test = require('node:test');
const assert = require('node:assert/strict');
const { syncOutcome } = require('../lib/team/sync-outcome');

const NO_POLICY = 'the sync did not report a policy state';

test('a missing or non-object result reports a missing policy state', () => {
  for (const input of [undefined, null, 0, 42, '', 'current', true, {}, []]) {
    assert.deepEqual(syncOutcome(input), { ok: false, policyOk: false, problems: [NO_POLICY] }, String(input));
  }
  assert.deepEqual(syncOutcome(), { ok: false, policyOk: false, problems: [NO_POLICY] });
});

test('a policy or upload that is not an object is ignored', () => {
  assert.deepEqual(syncOutcome({ policy: 'current' }).problems, [NO_POLICY]);
  assert.deepEqual(syncOutcome({ policy: null, upload: null }).problems, [NO_POLICY]);
  // A string upload status is not read, so no upload problem is added.
  assert.deepEqual(syncOutcome({ policy: { status: 'current' }, upload: 'offline' }),
    { ok: true, policyOk: true, problems: [] });
});

test('updated and current policies are good with no upload or a finished upload', () => {
  for (const status of ['updated', 'current']) {
    assert.deepEqual(syncOutcome({ policy: { status } }), { ok: true, policyOk: true, problems: [] });
    assert.deepEqual(syncOutcome({ policy: { status }, upload: null }), { ok: true, policyOk: true, problems: [] });
    for (const upStatus of ['uploaded', 'nothing', undefined, 'something-new']) {
      const o = syncOutcome({ policy: { status }, upload: { status: upStatus, pending: 0 } });
      assert.deepEqual(o, { ok: true, policyOk: true, problems: [] }, status + '/' + upStatus);
    }
  }
});

test('each failing policy status has its own message', () => {
  const cases = {
    none: 'the organization has not published a policy yet',
    rejected: 'the downloaded policy was refused',
    revoked: 'this machine was removed from the organization',
    offline: 'could not reach the zn server',
    stopped: 'the vault was locked before the sync finished',
    stale: 'this machine left or changed its organization while the sync was running; nothing was applied',
  };
  for (const [status, message] of Object.entries(cases)) {
    assert.deepEqual(syncOutcome({ policy: { status } }), { ok: false, policyOk: false, problems: [message] }, status);
  }
});

test('a rejected policy shows its error, and the clock hint only for an expired policy', () => {
  assert.deepEqual(syncOutcome({ policy: { status: 'rejected', error: 'bad signature' } }).problems,
    ['the downloaded policy was refused (bad signature)']);
  assert.deepEqual(syncOutcome({ policy: { status: 'rejected', error: '' } }).problems,
    ['the downloaded policy was refused']);
  assert.deepEqual(syncOutcome({ policy: { status: 'rejected', error: 'policy expired' } }).problems,
    ["the downloaded policy was refused (policy expired): this computer's clock may be ahead, so check its date and time"]);
  // Only the exact text gets the hint.
  assert.doesNotMatch(syncOutcome({ policy: { status: 'rejected', error: 'Policy Expired' } }).problems[0], /clock/);
});

test('a long or multi-line rejection error is cut to 160 characters on one line', () => {
  const p = syncOutcome({ policy: { status: 'rejected', error: 'x'.repeat(300) } }).problems[0];
  assert.equal(p, 'the downloaded policy was refused (' + 'x'.repeat(160) + ')');
  const q = syncOutcome({ policy: { status: 'rejected', error: 'line one\nline two\t\u007f' } }).problems[0];
  assert.equal(q, 'the downloaded policy was refused (line one line two  )');
});

test('an unknown policy status is named, cleaned and cut to 40 characters', () => {
  assert.deepEqual(syncOutcome({ policy: { status: 'paused' } }).problems, ['the policy state is unknown (paused)']);
  assert.deepEqual(syncOutcome({ policy: {} }).problems, ['the policy state is unknown ()']);
  assert.deepEqual(syncOutcome({ policy: { status: null } }).problems, ['the policy state is unknown ()']);
  assert.deepEqual(syncOutcome({ policy: { status: 7 } }).problems, ['the policy state is unknown (7)']);
  assert.deepEqual(syncOutcome({ policy: { status: 'a\r\nb' } }).problems, ['the policy state is unknown (a  b)']);
  assert.deepEqual(syncOutcome({ policy: { status: 'y'.repeat(41) } }).problems,
    ['the policy state is unknown (' + 'y'.repeat(40) + ')']);
});

test('every failed upload status is reported, with the pending count only when above zero', () => {
  for (const status of ['offline', 'revoked', 'rejected', 'diverged', 'local_gap', 'error', 'tampered']) {
    assert.deepEqual(syncOutcome({ policy: { status: 'current' }, upload: { status } }),
      { ok: false, policyOk: true, problems: ['audit upload failed (' + status + ')'] }, status);
    assert.deepEqual(syncOutcome({ policy: { status: 'current' }, upload: { status, pending: 3 } }).problems,
      ['audit upload failed (' + status + ', 3 records pending)'], status);
  }
  for (const pending of [0, -1, null, 'none']) {
    assert.deepEqual(syncOutcome({ policy: { status: 'updated' }, upload: { status: 'offline', pending } }).problems,
      ['audit upload failed (offline)'], String(pending));
  }
  assert.deepEqual(syncOutcome({ policy: { status: 'updated' }, upload: { status: 'offline', pending: 1 } }).problems,
    ['audit upload failed (offline, 1 records pending)']);
});

test('stale and inactive uploads have their own messages and ignore the pending count', () => {
  assert.deepEqual(syncOutcome({ policy: { status: 'current' }, upload: { status: 'stale', pending: 9 } }).problems,
    ['audit upload stopped: this machine left or changed its organization while it was running']);
  assert.deepEqual(syncOutcome({ policy: { status: 'current' }, upload: { status: 'inactive', pending: 9 } }),
    { ok: false, policyOk: true, problems: ['your organization is not active on zn right now'] });
});

test('an inactive organization with no policy reports only the inactive organization', () => {
  assert.deepEqual(syncOutcome({ policy: { status: 'none' }, upload: { status: 'inactive' } }),
    { ok: false, policyOk: false, problems: ['your organization is not active on zn right now'] });
  // Any other policy failure is still reported next to the inactive organization.
  assert.deepEqual(syncOutcome({ policy: { status: 'offline' }, upload: { status: 'inactive' } }).problems,
    ['could not reach the zn server', 'your organization is not active on zn right now']);
  // With a different upload failure, the missing policy is reported too.
  assert.deepEqual(syncOutcome({ policy: { status: 'none' }, upload: { status: 'offline' } }).problems,
    ['the organization has not published a policy yet', 'audit upload failed (offline)']);
});

test('a missing policy and a failed upload are both reported, policy first', () => {
  assert.deepEqual(syncOutcome({ upload: { status: 'error', pending: 2 } }),
    { ok: false, policyOk: false, problems: [NO_POLICY, 'audit upload failed (error, 2 records pending)'] });
});

test('the input is not changed', () => {
  const input = { policy: { status: 'rejected', error: 'policy expired' }, upload: { status: 'offline', pending: 4 } };
  const copy = JSON.parse(JSON.stringify(input));
  syncOutcome(input);
  assert.deepEqual(input, copy);
});
