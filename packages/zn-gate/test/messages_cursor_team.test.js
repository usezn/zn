'use strict';
/* The marker refusal and the Team no-subscription texts: plain words and one next step. */
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');
const messages = require('../lib/messages');
const { apiFailure } = require('../lib/team/upload');
const { PACKAGE_VERSION } = require('../lib/zn-command');

test('a refused secret marker is explained and the next step is a command for the user, with no fixed version', () => {
  const texts = [
    policy.wrapWithZnRun('psql __ZN_DB_PASSWORD__').reason,
    policy.wrapPowerShell('psql __ZN_DB_PASSWORD__', { agent: 'cursor' }).reason,
  ];
  for (const t of texts) {
    assert.match(t, /secret marker is a stand-in \(like __ZN_NAME__\) for a secret stored in zn/);
    assert.match(t, /ask the user to run `[^`]*run --secrets NAME -- <command>` in their own terminal/);
    // The only version that may appear is the installed one (the npx form, when zn is not on PATH).
    for (const m of t.matchAll(/zn-gate@([^\s`]+)/g)) assert.equal(m[1], PACKAGE_VERSION);
  }
});

test('join without a Team subscription says what to do and where', () => {
  const t = messages.teamJoinNoSubscription('HTTP 402');
  assert.match(t, /^join failed: this organization has no active Team subscription, so this machine was not connected\./);
  assert.match(t, /ask an admin of your organization to renew or start the Team plan at usezn\.com\/pricing/);
  assert.match(t, /zn team join <token>/);
  assert.match(t, /\ndetails: HTTP 402$/);
  assert.doesNotMatch(messages.teamJoinNoSubscription(), /HTTP|details/);
});

test('the status after an answer 402 is a plain sentence without the HTTP code', () => {
  const r = apiFailure(402);
  assert.equal(r.status, 'inactive');
  assert.doesNotMatch(r.text, /HTTP|402/);
  assert.match(r.text, /no active Team subscription.*renew or start the Team plan at usezn\.com\/pricing/);
});
