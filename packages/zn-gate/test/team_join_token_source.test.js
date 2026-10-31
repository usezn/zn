'use strict';
/*
 * `zn team join` takes the join token from an argument, from standard input (`-`) or from ZN_TEAM_JOIN_TOKEN.
 * An argument beats the environment and gets a one-line history warning; the token is never printed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-join-src-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const clientModule = require('../lib/vault/client');
let fake = {};
clientModule.createClient = () => new Proxy({}, {
  get(target, prop) {
    if (prop === 'close') return () => {};
    if (typeof fake[prop] === 'function') return fake[prop];
    return () => { throw Object.assign(new Error('unexpected call ' + String(prop)), { code: 'ZN_TEST' }); };
  },
});
const { runTeamCommand } = require('../lib/team/cli');

const TOK_ARG = 'znj_' + 'A'.repeat(40);
const TOK_ENV = 'znj_' + 'E'.repeat(40);
const TOK_IN = 'znj_' + 'S'.repeat(40);
let joined;

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  joined = null;
  fake = {
    teamJoin: async (a) => { joined = a; return { org: 'org_Example12345678', org_name: 'Example Org', install_id: 'inst-0001' }; },
    teamSync: async () => ({ policy: { status: 'updated', version: 1 } }),
  };
});

async function capture(fn) {
  const o = process.stdout.write; const e = process.stderr.write;
  let stdout = ''; let stderr = '';
  process.stdout.write = (s) => { stdout += s; return true; };
  process.stderr.write = (s) => { stderr += s; return true; };
  try { const code = await fn(); return { code, stdout, stderr }; } finally { process.stdout.write = o; process.stderr.write = e; }
}

test('an argument still works and prints a one-line history warning, without the token', async () => {
  const r = await capture(() => runTeamCommand(['team', 'join', TOK_ARG], { env: {} }));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(joined.join_token, TOK_ARG);
  assert.match(r.stderr, /shell history/);
  assert.match(r.stderr, /zn team join -/);
  assert.match(r.stderr, /ZN_TEAM_JOIN_TOKEN/);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
  assert.ok(!(r.stdout + r.stderr).includes(TOK_ARG));
});

test('`-` reads one line from standard input: no warning, token not echoed', async () => {
  const r = await capture(() => runTeamCommand(['team', 'join', '-', '--agent', 'codex'], { env: {}, readStdin: async () => TOK_IN }));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(joined.join_token, TOK_IN);
  assert.strictEqual(joined.agent, 'codex');
  assert.ok(!/history/.test(r.stderr));
  assert.ok(!(r.stdout + r.stderr).includes(TOK_IN));
});

test('`-` with nothing on standard input exits 2 and does not join', async () => {
  const r = await capture(() => runTeamCommand(['team', 'join', '-'], { env: { ZN_TEAM_JOIN_TOKEN: TOK_ENV }, readStdin: async () => '' }));
  assert.strictEqual(r.code, 2);
  assert.strictEqual(joined, null);
  assert.match(r.stderr, /no join token on standard input/);
});

test('no argument: ZN_TEAM_JOIN_TOKEN is used (also with only options), trimmed, no warning', async () => {
  for (const args of [['team', 'join'], ['team', 'join', '--api', 'https://team.example.com']]) {
    joined = null;
    const r = await capture(() => runTeamCommand(args, { env: { ZN_TEAM_JOIN_TOKEN: '  ' + TOK_ENV + '\n' } }));
    assert.strictEqual(r.code, 0);
    assert.strictEqual(joined.join_token, TOK_ENV);
    assert.ok(!/history/.test(r.stderr));
    assert.ok(!(r.stdout + r.stderr).includes(TOK_ENV));
  }
});

test('precedence: argument over the environment; `-` over the environment', async () => {
  let r = await capture(() => runTeamCommand(['team', 'join', TOK_ARG], { env: { ZN_TEAM_JOIN_TOKEN: TOK_ENV } }));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(joined.join_token, TOK_ARG);
  r = await capture(() => runTeamCommand(['team', 'join', '-'], { env: { ZN_TEAM_JOIN_TOKEN: TOK_ENV }, readStdin: async () => TOK_IN }));
  assert.strictEqual(joined.join_token, TOK_IN);
});

test('no token anywhere: a sentence, exit 2, and it mentions the other ways in', async () => {
  const r = await capture(() => runTeamCommand(['team', 'join'], { env: { ZN_TEAM_JOIN_TOKEN: '   ' } }));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /^\[zn\] No join token given\./);
  assert.match(r.stderr, /ZN_TEAM_JOIN_TOKEN/);
  assert.strictEqual(joined, null);
});

test('a real process reads the token from a pipe (the locked vault refuses, but the token was taken and never printed)', () => {
  const bin = path.resolve(__dirname, '..', 'bin', 'cli.js');
  const env = { ...process.env, ZN_HOME: path.join(HOME, 'proc', '.zn'), HOME: path.join(HOME, 'proc'), USERPROFILE: path.join(HOME, 'proc') };
  delete env.ZN_TEAM_JOIN_TOKEN;
  fs.mkdirSync(env.HOME, { recursive: true });
  let r = spawnSync(process.execPath, [bin, 'team', 'join', '-'], { env, input: TOK_IN + '\n', encoding: 'utf8', timeout: 20000 });
  assert.ok(!/^usage:/.test(r.stderr), r.stderr);
  assert.notStrictEqual(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes(TOK_IN));
  r = spawnSync(process.execPath, [bin, 'team', 'join', '-'], { env, input: '', encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 2);
  r = spawnSync(process.execPath, [bin, 'team', 'join'], { env: { ...env, ZN_TEAM_JOIN_TOKEN: TOK_ENV }, input: '', encoding: 'utf8', timeout: 20000 });
  assert.ok(!/^usage:/.test(r.stderr), r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(TOK_ENV));
});
