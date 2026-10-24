'use strict';
/*
 * Edge cases for the organization-rule merge: rule order, empty and malformed
 * input, pattern matching, approvals given as an object, detectors.
 */
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const { effective, approvalKey, secretMatches, detectorsOf, pickOpening, hostCovered, warnNotice } = require('../lib/team/effective');

const ORG = 'org_TestOrg12345678';
const LOCAL = { mode: 'env', allowHosts: ['api.example.com'], allowCommands: ['tool'], allowIn: ['header', 'body'] };
const run = (policy, local, extra) => effective('KEY_A', local === undefined ? LOCAL : local, Object.assign({ policy, state: 'active', agent: 'codex', agentTrusted: true }, extra || {}));

test('secretMatches: star, prefix star and exact name only', () => {
  assert.equal(secretMatches('*', 'ANY'), true);
  assert.equal(secretMatches('KEY_*', 'KEY_A'), true);
  assert.equal(secretMatches('KEY_*', 'KEY_'), true);
  assert.equal(secretMatches('KEY_*', 'OTHER_KEY_A'), false);
  assert.equal(secretMatches('KEY_A', 'KEY_A'), true);
  assert.equal(secretMatches('KEY_A', 'KEY_AB'), false);
  assert.equal(secretMatches('key_a', 'KEY_A'), false);
  assert.equal(secretMatches('*_A', 'KEY_A'), false);
});

test('empty and malformed input leaves the local settings, with defaults filled in', () => {
  for (const policy of [{ org: ORG }, { org: ORG, rules: null }, { org: ORG, rules: 'x' }, { org: ORG, rules: {} }, { org: ORG, rules: [] }]) {
    const r = run(policy);
    assert.equal(r.deny, false);
    assert.equal(r.warn, false);
    assert.deepEqual(r.pending, []);
    assert.deepEqual(r.meta, LOCAL);
  }
  const noPolicy = effective('KEY_A', LOCAL);
  assert.deepEqual(noPolicy.meta, LOCAL);
  assert.equal(noPolicy.deny, false);
  assert.equal(effective('KEY_A', LOCAL, null).deny, false);
  assert.equal(effective('KEY_A', LOCAL, { state: 'active' }).deny, false);
  const bare = effective('KEY_A', undefined, {});
  assert.deepEqual(bare.meta, { allowHosts: [], allowCommands: [], allowIn: ['header'] });
  const emptyIn = effective('KEY_A', { allowIn: [] }, {});
  assert.deepEqual(emptyIn.meta.allowIn, ['header']);
  const badIn = effective('KEY_A', { allowIn: 'body' }, {});
  assert.deepEqual(badIn.meta.allowIn, ['header']);
});

test('the local settings object passed in is never changed', () => {
  const local = { mode: 'file', allowHosts: ['api.example.com'], allowCommands: ['tool'], allowIn: ['header', 'body'] };
  const copy = JSON.parse(JSON.stringify(local));
  run({ org: ORG, rules: [{ secret: '*', agents: ['*'], allowHosts: [], allowCommands: [], mode: 'proxy', injectAt: 'body' }] }, local);
  assert.deepEqual(local, copy);
});

test('a rule with no restricting field matches but changes nothing', () => {
  const r = run({ org: ORG, rules: [{ secret: 'KEY_*', agents: ['*'] }] });
  assert.deepEqual(r.meta, LOCAL);
  assert.equal(r.rule, 0);
  assert.equal(r.deny, false);
  assert.equal(r.reason, undefined);
});

test('rule index points at the first matching rule, or at the denying one', () => {
  const rules = [
    { secret: 'OTHER', agents: ['*'], deny: true },
    { secret: 'KEY_*', agents: ['*'], allowCommands: ['tool'] },
    { secret: 'KEY_A', agents: ['*'], deny: true },
  ];
  const r = run({ org: ORG, rules });
  assert.equal(r.deny, true);
  assert.equal(r.rule, 2);
  assert.equal(r.reason, 'policy:org_deny');
  const noDeny = run({ org: ORG, rules: rules.slice(0, 2) });
  assert.equal(noDeny.rule, 1);
});

test('only a deny of exactly true counts; other values are ignored', () => {
  for (const deny of ['true', 1, null, undefined, false]) {
    assert.equal(run({ org: ORG, rules: [{ secret: '*', agents: ['*'], deny }] }).deny, false, String(deny));
  }
  assert.equal(run({ org: ORG, rules: [{ secret: '*', agents: ['*'], warn: 'yes' }] }).warn, false);
});

test('the first warn rule wins; a non-string reason is dropped', () => {
  const rules = [
    { secret: 'OTHER', agents: ['*'], warn: true, reason: 'not me' },
    { secret: 'KEY_*', agents: ['*'], warn: true, reason: 123 },
    { secret: 'KEY_A', agents: ['*'], warn: true, reason: 'second' },
  ];
  const r = run({ org: ORG, rules });
  assert.equal(r.warn, true);
  assert.equal(r.warnRule, 1);
  assert.equal(r.warnReason, undefined);
});

test('org is taken from the options first, then from the policy', () => {
  const p = { org: ORG, rules: [{ secret: 'X', agents: ['*'] }] };
  assert.equal(run(p).org, ORG);
  assert.equal(run(p, undefined, { org: 'org_Other123456789' }).org, 'org_Other123456789');
});

test('merge order: allowCommands and injectAt narrow step by step in rule order', () => {
  const local = { allowCommands: ['git', 'npm'], allowIn: ['header', 'body', 'query'], allowHosts: [] };
  const rules = [
    { secret: '*', agents: ['*'], allowCommands: ['git push', 'git pull', 'npm'], injectAt: 'body' },
    { secret: 'KEY_*', agents: ['*'], allowCommands: ['git push', 'npm install'] },
  ];
  const r = run({ org: ORG, rules }, local);
  // The second rule is compared with what the first one left: "npm install" is narrower than "npm".
  assert.deepEqual(r.meta.allowCommands, ['git push', 'npm install']);
  assert.deepEqual(r.meta.allowIn, ['body']);
  // Two different injectAt values leave nothing.
  const both = run({ org: ORG, rules: [{ secret: '*', agents: ['*'], injectAt: 'body' }, { secret: '*', agents: ['*'], injectAt: 'header' }] }, local);
  assert.deepEqual(both.meta.allowIn, []);
  // With the rules swapped, the broad "npm" no longer fits under "npm install", so the result differs.
  const swapped = run({ org: ORG, rules: rules.slice().reverse() }, local);
  assert.deepEqual(swapped.meta.allowCommands, ['git push']);
  assert.deepEqual(swapped.meta.allowIn, ['body']);
});

test('a command that only shares letters with a local entry is not covered', () => {
  const local = { allowCommands: ['git'], allowIn: ['header'], allowHosts: [] };
  const r = run({ org: ORG, rules: [{ secret: '*', agents: ['*'], allowCommands: ['gitk', 'git-lfs', 'git status'] }] }, local);
  assert.deepEqual(r.meta.allowCommands, ['git status']);
});

test('an empty allowHosts list removes every host; a missing one keeps them', () => {
  assert.deepEqual(run({ org: ORG, rules: [{ secret: '*', agents: ['*'], allowHosts: [] }] }).meta.allowHosts, []);
  assert.deepEqual(run({ org: ORG, rules: [{ secret: '*', agents: ['*'], allowHosts: 'api.example.com' }] }).meta.allowHosts, ['api.example.com']);
  assert.deepEqual(run({ org: ORG, rules: [{ secret: '*', agents: ['*'] }] }).meta.allowHosts, ['api.example.com']);
});

test('host comparison ignores case; hosts with a port only restrict', () => {
  const p = { org: ORG, rules: [{ secret: '*', agents: ['*'], allowHosts: ['API.Example.COM', 'api.example.com:8443'] }] };
  const r = run(p);
  assert.deepEqual(r.meta.allowHosts, ['API.Example.COM']);
  assert.deepEqual(r.pending, []);
  assert.equal(hostCovered(['API.EXAMPLE.COM'], 'Api.Example.Com'), true);
  assert.equal(hostCovered(undefined, 'a.example.com'), false);
});

test('a rule without an agents list can open no host', () => {
  const p = { org: ORG, rules: [{ secret: '*', allowHosts: ['api.example.com', 'new.example.net'] }] };
  const r = run(p, undefined, { approvals: new Set([approvalKey(ORG, 'KEY_A', 'host', 'new.example.net')]) });
  assert.deepEqual(r.meta.allowHosts, ['api.example.com']);
  assert.deepEqual(r.pending, []);
});

test('approvals may be a plain object; an empty or odd value approves nothing', () => {
  const p = { org: ORG, rules: [{ secret: 'KEY_A', agents: ['*'], allowHosts: ['api.example.com', 'new.example.net'] }] };
  const key = approvalKey(ORG, 'KEY_A', 'host', 'new.example.net');
  assert.deepEqual(run(p, undefined, { approvals: { [key]: true } }).meta.allowHosts, ['api.example.com', 'new.example.net']);
  for (const approvals of [{}, new Set(), null, undefined, 0, '']) {
    const r = run(p, undefined, { approvals });
    assert.deepEqual(r.meta.allowHosts, ['api.example.com']);
    assert.deepEqual(r.pending, [{ kind: 'host', value: 'new.example.net' }]);
  }
  // An approval is tied to the secret name too.
  const other = new Set([approvalKey(ORG, 'KEY_B', 'host', 'new.example.net')]);
  assert.deepEqual(run(p, undefined, { approvals: other }).meta.allowHosts, ['api.example.com']);
});

test('approvalKey joins its parts with a NUL so values cannot run together', () => {
  assert.equal(approvalKey('a', 'b', 'host', 'c'), 'a\u0000b\u0000host\u0000c');
  assert.notEqual(approvalKey('a', 'b c', 'host', 'd'), approvalKey('a', 'b', 'c host', 'd'));
});

test('an agent name must match the rule exactly; a trusted agent without a name opens nothing', () => {
  const p = { org: ORG, rules: [{ secret: '*', agents: ['codex'], allowHosts: ['api.example.com', 'new.example.net'] }] };
  assert.deepEqual(run(p, undefined, { agent: 'Codex' }).pending, []);
  assert.deepEqual(run(p, undefined, { agent: '', agentTrusted: true }).pending, []);
  assert.deepEqual(run(p, undefined, { agent: 'codex' }).pending, [{ kind: 'host', value: 'new.example.net' }]);
});

test('a wildcard org host with no local cover is offered as one entry', () => {
  const p = { org: ORG, rules: [{ secret: '*', agents: ['*'], allowHosts: ['*.example.net'] }] };
  const r = run(p);
  assert.deepEqual(r.meta.allowHosts, []);
  assert.deepEqual(r.pending, [{ kind: 'host', value: '*.example.net' }]);
});

test('pickOpening ignores other kinds, empty input and prefers an exact entry', () => {
  assert.equal(pickOpening(undefined, 'host', () => true), null);
  assert.equal(pickOpening([], 'host', () => true), null);
  assert.equal(pickOpening([{ kind: 'command', value: 'x' }], 'host', () => true), null);
  const pending = [{ kind: 'host', value: '*.example.net' }, { kind: 'host', value: 'a.example.net' }];
  assert.deepEqual(pickOpening(pending, 'host', () => true), { kind: 'host', value: 'a.example.net', wildcard: false });
  const wild = [{ kind: 'host', value: '*.net' }, { kind: 'host', value: '*.example.net' }];
  assert.deepEqual(pickOpening(wild, 'host', () => true), { kind: 'host', value: '*.example.net', wildcard: true });
});

test('detectorsOf: active and expired policies give detectors, anything else gives none', () => {
  const detectors = [{ id: 'd1', pattern: 'abc', type: 'x' }];
  assert.deepEqual(detectorsOf({ state: 'active', policy: { detectors } }), detectors);
  assert.deepEqual(detectorsOf({ state: 'expired', policy: { detectors } }), detectors);
  for (const st of [undefined, null, {}, { state: 'none', policy: { detectors } }, { state: 'invalid', policy: { detectors } },
    { state: 'active' }, { state: 'active', policy: {} }, { state: 'active', policy: { detectors: 'x' } }, { state: 'active', policy: { detectors: {} } }]) {
    assert.deepEqual(detectorsOf(st), []);
  }
});

test('warnNotice treats a non-string or blank reason as no reason', () => {
  const plain = 'zn: your team policy would block K here. It was allowed and recorded for your organization.';
  for (const reason of [undefined, null, 5, {}, '', '   ', '\u200b\u202e']) assert.equal(warnNotice('K', reason), plain);
});
