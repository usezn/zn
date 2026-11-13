'use strict';
/* Pasting the invitation email link (or its zninv_ token) into `zn team join` explains the two steps and contacts nothing. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-invite-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
const clientModule = require('../lib/vault/client');
let calls = 0;
clientModule.createClient = () => new Proxy({}, { get(t, p) { if (p === 'close') return () => {}; return () => { calls++; throw new Error('unexpected call ' + String(p)); }; } });
const { runTeamCommand } = require('../lib/team/cli');
const messages = require('../lib/messages');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

async function capture(fn) {
  const o = process.stdout.write; const e = process.stderr.write;
  let stdout = ''; let stderr = '';
  process.stdout.write = (s) => { stdout += s; return true; };
  process.stderr.write = (s) => { stderr += s; return true; };
  try { const code = await fn(); return { code, stdout, stderr }; } finally { process.stdout.write = o; process.stderr.write = e; }
}

const LINKS = ['zninv_' + 'A'.repeat(40) + '.org_Example1234', 'https://usezn.com/team?invite=zninv_' + 'B'.repeat(40) + '.org_Example1234'];
for (const val of LINKS) {
  test('an invitation link is not a join token: ' + val.slice(0, 24), async () => {
    calls = 0;
    const r = await capture(() => runTeamCommand(['team', 'join', val], { env: {} }));
    assert.strictEqual(r.code, 2);
    assert.strictEqual(calls, 0);
    assert.strictEqual(r.stderr, '[zn] ' + messages.TEAM_INVITE_NOT_A_JOIN_TOKEN + '\n');
    assert.ok(!r.stderr.includes('zninv_'));
  });
}

test('the same link on standard input gets the same message', async () => {
  const r = await capture(() => runTeamCommand(['team', 'join', '-'], { env: {}, readStdin: async () => LINKS[0] }));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /join token \(it starts with znj_\)/);
});

test('a real join token is not taken for an invitation', () => {
  assert.ok(!messages.looksLikeEmailInvite('znj_' + 'A'.repeat(40)));
  assert.match(messages.TEAM_INVITE_NOT_A_JOIN_TOKEN, /usezn\.com\/team.*znj_/);
  assert.ok(messages.TEAM_INVITE_NOT_A_JOIN_TOKEN.endsWith(require('../lib/zn-command').znCommand('team join <token>')));
});
