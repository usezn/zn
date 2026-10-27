'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { syncOutcome } = require('../lib/team/sync-outcome');

const NO_POLICY = 'the sync did not report a policy state';
const UP = (status, pending) => ({ status, pending });

const CASES = [
  // [name, input, ok, policyOk, problems]
  ['policy updated, no upload', { policy: { status: 'updated' } }, true, true, []],
  ['policy current, no upload', { policy: { status: 'current' } }, true, true, []],
  ['policy updated, upload ok', { policy: { status: 'updated' }, upload: UP('uploaded', 3) }, true, true, []],
  ['policy current, upload nothing to send', { policy: { status: 'current' }, upload: UP('idle', 0) }, true, true, []],
  ['policy current, upload with unknown status is not a failure', { policy: { status: 'current' }, upload: UP('whatever') }, true, true, []],
  ['no policy none', { policy: { status: 'none' } }, false, false, ['the organization has not published a policy yet']],
  ['policy rejected, no error', { policy: { status: 'rejected' } }, false, false, ['the downloaded policy was refused']],
  ['policy rejected, with error', { policy: { status: 'rejected', error: 'bad signature' } }, false, false, ['the downloaded policy was refused (bad signature)']],
  ['policy revoked', { policy: { status: 'revoked' } }, false, false, ['this machine was removed from the organization']],
  ['policy offline, no error', { policy: { status: 'offline' } }, false, false, ['could not reach the server']],
  ['policy offline, with error', { policy: { status: 'offline', error: 'ECONNREFUSED' } }, false, false, ['could not reach the server (ECONNREFUSED)']],
  ['policy stopped', { policy: { status: 'stopped' } }, false, false, ['the vault was locked before the sync finished']],
  ['policy stale', { policy: { status: 'stale' } }, false, false, ['this machine left or changed its organization while the sync was running; nothing was applied']],
  ['policy unknown status', { policy: { status: 'weird' } }, false, false, ['the policy state is unknown (weird)']],
  ['policy without status', { policy: {} }, false, false, ['the policy state is unknown ()']],
  ['policy status wrong type', { policy: { status: 42 } }, false, false, ['the policy state is unknown (42)']],
  ['policy status uppercase is unknown', { policy: { status: 'UPDATED' } }, false, false, ['the policy state is unknown (UPDATED)']],
  ['policy ok, upload stale', { policy: { status: 'updated' }, upload: UP('stale') }, false, true, ['audit upload stopped: this machine left or changed its organization while it was running']],
  ['policy ok, upload offline with pending', { policy: { status: 'current' }, upload: UP('offline', 5) }, false, true, ['audit upload failed (offline, 5 records pending)']],
  ['policy ok, upload error without pending', { policy: { status: 'current' }, upload: UP('error') }, false, true, ['audit upload failed (error)']],
  ['policy ok, upload failed with zero pending', { policy: { status: 'current' }, upload: UP('rejected', 0) }, false, true, ['audit upload failed (rejected)']],
  ['policy ok, upload pending as numeric string is coerced', { policy: { status: 'current' }, upload: { status: 'diverged', pending: '4' } }, false, true, ['audit upload failed (diverged, 4 records pending)']],
  ['both fail', { policy: { status: 'offline' }, upload: UP('offline', 2) }, false, false, ['could not reach the server', 'audit upload failed (offline, 2 records pending)']],
  ['missing policy with upload fine', { upload: UP('uploaded', 0) }, false, false, [NO_POLICY]],
  ['empty object', {}, false, false, [NO_POLICY]],
  ['null', null, false, false, [NO_POLICY]],
  ['undefined', undefined, false, false, [NO_POLICY]],
  ['string', 'updated', false, false, [NO_POLICY]],
  ['number', 7, false, false, [NO_POLICY]],
  ['array', [], false, false, [NO_POLICY]],
  ['policy null', { policy: null }, false, false, [NO_POLICY]],
  ['policy is a string', { policy: 'updated' }, false, false, [NO_POLICY]],
  ['upload is a string (ignored)', { policy: { status: 'current' }, upload: 'offline' }, true, true, []],
  ['upload null (ignored)', { policy: { status: 'current' }, upload: null }, true, true, []],
];

for (const [name, input, ok, policyOk, problems] of CASES) {
  test('syncOutcome: ' + name, () => {
    const out = syncOutcome(input);
    assert.deepStrictEqual(out, { ok, policyOk, problems });
  });
}

test('every documented upload failure status is a problem', () => {
  for (const s of ['offline', 'revoked', 'inactive', 'rejected', 'diverged', 'local_gap', 'error', 'tampered']) {
    const out = syncOutcome({ policy: { status: 'current' }, upload: UP(s, 1) });
    assert.strictEqual(out.ok, false, s);
    assert.strictEqual(out.problems.length, 1, s);
    assert.ok(out.problems[0].includes(s), s);
  }
});

test('error text is sanitised and truncated (control characters, length)', () => {
  const rej = syncOutcome({ policy: { status: 'rejected', error: 'a\nb\u0000c' + 'x'.repeat(300) } });
  assert.ok(!/[\u0000-\u001f]/.test(rej.problems[0]));
  assert.ok(rej.problems[0].startsWith('the downloaded policy was refused (a b c'));
  assert.strictEqual(rej.problems[0].length, 'the downloaded policy was refused ()'.length + 120);
  const off = syncOutcome({ policy: { status: 'offline', error: 'y'.repeat(200) } });
  assert.strictEqual(off.problems[0], 'could not reach the server (' + 'y'.repeat(60) + ')');
  const unk = syncOutcome({ policy: { status: 'z'.repeat(100) } });
  assert.strictEqual(unk.problems[0], 'the policy state is unknown (' + 'z'.repeat(40) + ')');
});

test('does not mutate its input', () => {
  const input = { policy: { status: 'offline', error: 'e' }, upload: UP('offline', 1) };
  const copy = JSON.parse(JSON.stringify(input));
  syncOutcome(input);
  assert.deepStrictEqual(input, copy);
});
