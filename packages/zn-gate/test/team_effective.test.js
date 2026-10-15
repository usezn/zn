'use strict';
/*
 * How an organization rule changes a secret's local settings: restrict
 * freely, open only hosts with a local approval for an agent zn can
 * identify, and never let a self-reported agent id dodge a rule.
 */
const test = require('node:test');
const assert = require('node:assert');
const { effective, approvalKey, hostCovered, pickOpening, warnNotice, WARN_REASON } = require('../lib/team/effective');

const ORG = 'org_TestOrg12345678';
const LOCAL = { mode: 'env', allowHosts: ['api.stripe.com', 'files.stripe.com'], allowCommands: ['stripe'], allowIn: ['header', 'body', 'query'] };
const pol = (rules) => ({ org: ORG, version: 1, rules });
const trusted = (agent) => ({ agent, agentTrusted: true });
const eff = (name, p, who, extra) => effective(name, LOCAL, Object.assign({ policy: p, state: 'active' }, who, extra || {}));

test('a deny applies to every caller, whatever agents the rule names', () => {
  const p = pol([{ secret: 'PROD_*', agents: ['codex'], deny: true }]);
  assert.strictEqual(eff('PROD_DB', p, trusted('codex')).deny, true);
  // zn-gate cannot prove which agent is calling: no id dodges a restriction.
  assert.strictEqual(eff('PROD_DB', p, trusted('claude-code')).deny, true);
  assert.strictEqual(eff('PROD_DB', p, { agent: 'claude-code', agentTrusted: false }).deny, true);
  assert.strictEqual(eff('PROD_DB', p, { agent: 'mcp' }).deny, true);
  assert.strictEqual(eff('PROD_DB', p, { agent: null }).deny, true);
  assert.strictEqual(eff('DEV_DB', p, trusted('codex')).deny, false);
  assert.strictEqual(eff('PROD_DB', p, trusted('codex'), { state: 'expired' }).deny, true);
});

test('for an untrusted agent, every matching rule restricts and none opens', () => {
  const p = pol([
    { secret: 'STRIPE_KEY', agents: ['codex'], allowHosts: ['api.stripe.com', 'evil.example.net'] },
    { secret: 'STRIPE_*', agents: ['claude-code'], allowCommands: [], mode: 'proxy', injectAt: 'header' },
  ]);
  const r = eff('STRIPE_KEY', p, { agent: 'codex', agentTrusted: false });
  assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(r.meta.allowCommands, []);
  assert.strictEqual(r.meta.mode, 'proxy');
  assert.deepStrictEqual(r.meta.allowIn, ['header']);
  assert.deepStrictEqual(r.pending, []);
});

test('every matching rule restricts, in any order; an earlier narrowing beats a later opening', () => {
  const denyLater = pol([
    { secret: 'PROD_DB', agents: ['*'], allowHosts: ['api.stripe.com'] },
    { secret: 'PROD_*', agents: ['*'], deny: true },
  ]);
  assert.strictEqual(eff('PROD_DB', denyLater, trusted('codex')).deny, true);
  const p = pol([
    { secret: 'STRIPE_*', agents: ['codex'], allowHosts: ['api.stripe.com'] },
    { secret: 'STRIPE_KEY', agents: ['claude-code'], allowHosts: ['api.stripe.com', 'evil.example.net'] },
  ]);
  const approvals = new Set([approvalKey(ORG, 'STRIPE_KEY', 'host', 'evil.example.net')]);
  const r = eff('STRIPE_KEY', p, trusted('claude-code'), { approvals });
  assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(r.pending, []);
});

test('restricting applies at once: fewer hosts and commands, proxy mode, placement cut to injectAt', () => {
  const p = pol([{ secret: '*', agents: ['*'], allowHosts: ['api.stripe.com'], allowCommands: [], mode: 'proxy', injectAt: 'header' }]);
  const r = eff('STRIPE_KEY', p, trusted('claude-code'));
  assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(r.meta.allowCommands, []);
  assert.strictEqual(r.meta.mode, 'proxy');
  assert.deepStrictEqual(r.meta.allowIn, ['header']);
  assert.deepStrictEqual(r.pending, []);
  // injectAt never adds a placement the local settings do not allow.
  const q = effective('X', { mode: 'proxy', allowHosts: [], allowCommands: [], allowIn: ['header'] },
    { policy: pol([{ secret: '*', agents: ['*'], injectAt: 'query' }]), state: 'active', agent: 'codex', agentTrusted: true });
  assert.deepStrictEqual(q.meta.allowIn, []);
});

test('only hosts can be opened, with a local approval; strict mode withdraws them', () => {
  const p = pol([{ secret: 'STRIPE_KEY', agents: ['claude-code'], allowHosts: ['api.stripe.com', 'evil.example.net', 'pay.example.net:8443'], allowCommands: ['stripe', 'python3'], mode: 'file', injectAt: 'body' }]);
  const r = eff('STRIPE_KEY', p, trusted('claude-code'));
  assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(r.meta.allowCommands, ['stripe']);
  assert.strictEqual(r.meta.mode, 'env');
  assert.deepStrictEqual(r.meta.allowIn, ['body']);
  assert.deepStrictEqual(r.pending, [{ kind: 'host', value: 'evil.example.net' }]);
  const approvals = new Set([approvalKey(ORG, 'STRIPE_KEY', 'host', 'evil.example.net')]);
  assert.deepStrictEqual(eff('STRIPE_KEY', p, trusted('claude-code'), { approvals }).meta.allowHosts, ['api.stripe.com', 'evil.example.net']);
  // Approved, but the agent id is self-reported: not applied.
  assert.deepStrictEqual(eff('STRIPE_KEY', p, { agent: 'claude-code' }, { approvals }).meta.allowHosts, ['api.stripe.com']);
  const s = eff('STRIPE_KEY', p, trusted('claude-code'), { approvals, state: 'expired' });
  assert.deepStrictEqual(s.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(s.pending, []);
  // An approval for another organization does not count.
  const other = new Set([approvalKey('org_Other123456789', 'STRIPE_KEY', 'host', 'evil.example.net')]);
  assert.deepStrictEqual(eff('STRIPE_KEY', p, trusted('claude-code'), { approvals: other }).meta.allowHosts, ['api.stripe.com']);
});

test('the most specific pending host is offered first', () => {
  const pending = [{ kind: 'host', value: '*.example.net' }, { kind: 'host', value: 'api.example.net' }];
  assert.deepStrictEqual(pickOpening(pending, 'host', (v) => hostCovered([v], 'api.example.net')), { kind: 'host', value: 'api.example.net', wildcard: false });
  assert.strictEqual(pickOpening(pending, 'host', (v) => hostCovered([v], 'other.example.net')).wildcard, true);
  assert.strictEqual(pickOpening(pending, 'host', () => false), null);
});

test('no policy, an invalid cache or no state leaves local settings alone', () => {
  const p = pol([{ secret: '*', agents: ['*'], deny: true }]);
  for (const state of ['none', 'invalid', undefined]) {
    const r = effective('X', LOCAL, { policy: p, state, agent: 'codex', agentTrusted: true });
    assert.strictEqual(r.deny, false);
    assert.deepStrictEqual(r.meta.allowHosts, LOCAL.allowHosts);
  }
});

test('local wildcards cover org hosts; org wildcards need an equal or broader local one', () => {
  assert.strictEqual(hostCovered(['*.stripe.com'], 'api.stripe.com'), true);
  assert.strictEqual(hostCovered(['*.stripe.com'], 'stripe.com'), false);
  assert.strictEqual(hostCovered(['*.stripe.com'], '*.api.stripe.com'), true);
  assert.strictEqual(hostCovered(['api.stripe.com'], '*.stripe.com'), false);
  assert.strictEqual(hostCovered(['*.com'], '*.stripe.com'), true);
  assert.strictEqual(hostCovered([], 'a.b'), false);
});

test('a host a later rule removes is not offered for approval', () => {
  const p = pol([
    { secret: 'STRIPE_KEY', agents: ['claude-code'], allowHosts: ['api.stripe.com', 'evil.example.net'] },
    { secret: 'STRIPE_*', agents: ['*'], allowHosts: ['api.stripe.com'] },
  ]);
  const r = eff('STRIPE_KEY', p, trusted('claude-code'));
  assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(r.pending, []);
});

test('narrowing commands keeps an organization entry that a local entry covers by word prefix', () => {
  const local = { mode: 'env', allowHosts: [], allowCommands: ['git', 'npm publish'], allowIn: ['header'] };
  const p = pol([{ secret: '*', agents: ['*'], allowCommands: ['git push', 'npm', 'curl'] }]);
  const r = effective('GH_TOKEN', local, { policy: p, state: 'active', agent: 'codex', agentTrusted: true });
  // "git push" is narrower than local "git"; "npm" would widen "npm publish"; curl was never allowed.
  assert.deepStrictEqual(r.meta.allowCommands, ['git push']);
});

test('warn lets the secret through, keeps the other restrictions, and loses to a deny', () => {
  const p = pol([{ secret: 'PROD_*', agents: ['codex'], warn: true, reason: 'Needs review', allowHosts: ['api.stripe.com'], mode: 'proxy' }]);
  for (const who of [trusted('codex'), trusted('claude-code'), { agent: null }]) {
    const r = eff('PROD_DB', p, who);
    assert.strictEqual(r.deny, false);
    assert.strictEqual(r.warn, true);
    assert.strictEqual(r.warnReason, 'Needs review');
    assert.strictEqual(r.warnRule, 0);
    assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
    assert.strictEqual(r.meta.mode, 'proxy');
  }
  assert.strictEqual(eff('PROD_DB', p, trusted('codex'), { state: 'expired' }).warn, true);
  assert.strictEqual(eff('DEV_DB', p, trusted('codex')).warn, false);
  const denyToo = pol([
    { secret: 'PROD_*', agents: ['*'], warn: true },
    { secret: 'PROD_DB', agents: ['*'], deny: true },
  ]);
  const r = eff('PROD_DB', denyToo, trusted('codex'));
  assert.strictEqual(r.deny, true);
  assert.strictEqual(r.warn, false);
  assert.strictEqual(r.reason, 'policy:org_deny');
});

test('a policy without warn rules gives the same result as before', () => {
  const p = pol([{ secret: 'PROD_*', agents: ['*'], deny: true }, { secret: 'STRIPE_KEY', agents: ['*'], allowCommands: ['stripe'] }]);
  assert.strictEqual(eff('PROD_DB', p, trusted('codex')).warn, false);
  const s = eff('STRIPE_KEY', p, trusted('codex'));
  assert.strictEqual(s.warn, false);
  assert.strictEqual(s.deny, false);
  assert.deepStrictEqual(s.meta.allowCommands, ['stripe']);
});

test('the warn notice names the secret and the rule reason in plain words', () => {
  assert.strictEqual(warnNotice('PROD_DB', 'Production credentials need review.'),
    'zn: your team policy would block PROD_DB here (policy note: "Production credentials need review."). It was allowed and recorded for your organization.');
  assert.strictEqual(warnNotice('PROD_DB'),
    'zn: your team policy would block PROD_DB here. It was allowed and recorded for your organization.');
  assert.ok(!/[\u0000-\u001f]/.test(warnNotice('PROD_DB', 'a\nb\u001b[31m')));
  const odd = warnNotice('PROD_DB', 'ok\u202e\u200b\u0085\u2028 "quoted" ' + 'x'.repeat(300));
  assert.ok(!/[\u0080-\u009f\u200b-\u200f\u2028-\u202e]/.test(odd));
  assert.match(odd, /\(policy note: "ok 'quoted' x+"\)\. It was allowed/);
  assert.ok(odd.length < 320);
  assert.strictEqual(WARN_REASON, 'policy:warn');
});
