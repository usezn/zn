'use strict';
// zn team join: the join token is not sent anywhere before the user agrees to the lookup.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-join-order-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
const { makeTeamOps } = require('../lib/team/daemon-ops');
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const TOKEN = 'znj_' + 'A'.repeat(40);

/** Ops with a recording fetch and a scripted confirmation: answers[i] true, false or 'nochannel'. */
function ops(answers) {
  const events = []; const secrets = { auditKey: 'ab'.repeat(32) };
  const fetchImpl = async (url, init) => {
    events.push('fetch ' + String(url));
    const org = { org_name: 'Order Org', invited_by: 'Dana', expires_at: '2030-01-01T00:00:00Z' };
    if (String(url).endsWith('/v1/org/join-preview')) return new Response(JSON.stringify(org), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
  };
  const state = { opts: { home: process.env.ZN_HOME }, paths: { auditFile: path.join(process.env.ZN_HOME, "audit.jsonl") }, loadSecrets: async () => secrets, saveSecrets: async () => {}, serial: (fn) => fn() };
  let i = 0;
  const o = makeTeamOps({
    state, fetchImpl, writeAudit: () => {},
    confirmOutOfBand: async (req) => {
      events.push('confirm ' + req.title);
      const a = answers[i++];
      if (a === 'nochannel') { const e = new Error('no confirmation channel'); e.code = 'ZN_POLICY_DENIED'; e.noChannel = true; throw e; }
      if (a !== true) throw new Error('declined');
    },
  });
  return { o, events };
}

test('declining the lookup makes zero requests, and the dialog never carries the full token', async () => {
  const x = ops([false]);
  await assert.rejects(x.o.teamJoin({ join_token: TOKEN }), /declined/);
  assert.deepStrictEqual(x.events, ['confirm look up the organization for this join token?']);
});

test('no confirmation channel (no TTY, agent run) makes zero requests', async () => {
  const x = ops(['nochannel']);
  await assert.rejects(x.o.teamJoin({ join_token: TOKEN }), /no confirmation channel/);
  assert.ok(!x.events.some((e) => e.startsWith('fetch')));
});

test('order: lookup confirmation, then preview, then join confirmation, then join', async () => {
  const x = ops([true, true]);
  await assert.rejects(x.o.teamJoin({ join_token: TOKEN }));
  assert.strictEqual(x.events[0], 'confirm look up the organization for this join token?');
  assert.strictEqual(x.events[1], 'fetch https://api.usezn.com/v1/org/join-preview');
  assert.match(x.events[2], /^confirm connect this machine to Order Org\?/);
  assert.match(x.events[3], /^fetch https:\/\/api\.usezn\.com\/v1\/org\/join/);
});

test('declining the second dialog makes no join request', async () => {
  const x = ops([true, false]);
  await assert.rejects(x.o.teamJoin({ join_token: TOKEN }), /declined/);
  assert.strictEqual(x.events.filter((e) => e.startsWith('fetch')).length, 1);
});

test('another server: one dialog, no lookup, nothing sent before it', async () => {
  const x = ops([false]);
  await assert.rejects(x.o.teamJoin({ join_token: TOKEN, api_base: 'https://zn.example.com' }), /declined/);
  assert.deepStrictEqual(x.events, ['confirm connect this machine to a zn organization?']);
});
