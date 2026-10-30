'use strict';
/*
 * `zn team ...` (lib/team/cli.js), the cases the stand-in client tests do not
 * cover: help text, exact usage lines, option passing, the managed-config
 * hand-off and the shape of the status JSON.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-cli-cmds-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const clientModule = require('../lib/vault/client');
let ops = {};
let closed = 0;
clientModule.createClient = () => new Proxy({}, {
  get(target, prop) {
    if (prop === 'close') return () => { closed++; };
    if (typeof ops[prop] === 'function') return ops[prop];
    return () => { throw new Error('unexpected call ' + String(prop)); };
  },
});

const { runTeamCommand } = require('../lib/team/cli');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => { ops = {}; closed = 0; });

async function capture(fn) {
  const o = process.stdout.write;
  const e = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = (s) => { stdout += s; return true; };
  process.stderr.write = (s) => { stderr += s; return true; };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

const USAGE_START = 'usage: zn team join <token> [--api URL] [--agent ID] [--include-history] | zn team status [--json] | zn team sync | zn team leave | zn team managed-config';

test('--help and -h print the usage on stdout and exit 0, wherever they appear', async () => {
  for (const args of [['team', '--help'], ['team', '-h'], ['team', 'join', '--help'], ['team', 'sync', '-h'], ['team', 'bogus', '--help'], ['team', 'status', '--json', '-h']]) {
    const r = await capture(() => runTeamCommand(args));
    assert.strictEqual(r.code, 0, args.join(' '));
    assert.ok(r.stdout.startsWith(USAGE_START), args.join(' '));
    assert.strictEqual(r.stdout.split('\n').length, 2, 'one line of usage');
    assert.strictEqual(r.stderr, '');
  }
  assert.strictEqual(closed, 0, 'help never opens a vault client');
});

test('the usage error is the same line as the help text, on stderr', async () => {
  const help = await capture(() => runTeamCommand(['team', '-h']));
  const bad = await capture(() => runTeamCommand(['team', 'nope']));
  assert.strictEqual(bad.code, 2);
  assert.strictEqual(bad.stdout, '');
  assert.strictEqual(bad.stderr, help.stdout);
  assert.strictEqual(closed, 0);
});

test('subcommand names are case sensitive and extra words are not subcommands', async () => {
  for (const sub of ['JOIN', 'Status', 'leave now', '--json']) {
    const r = await capture(() => runTeamCommand(['team', sub]));
    assert.strictEqual(r.code, 2, sub);
    assert.match(r.stderr, /^usage: zn team join/);
  }
});

test('join with an empty token is a usage error', async () => {
  ops.teamJoin = async () => { throw new Error('must not be called'); };
  const r = await capture(() => runTeamCommand(['team', 'join', '']));
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /^usage: zn team join <token>/);
});

test('join without options sends undefined for --api and --agent', async () => {
  let got = null;
  ops.teamJoin = async (a) => { got = a; return { org: 'org_Example12345678', install_id: 'inst-1' }; };
  ops.teamSync = async () => ({ policy: { status: 'current' } });
  const r = await capture(() => runTeamCommand(['team', 'join', 'znj_' + 'e'.repeat(32)]));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(got.api_base, undefined);
  assert.strictEqual(got.agent, undefined);
  assert.match(r.stdout, /Policy: current\.\n$/);
});

test('join accepts options before the end and ignores a trailing flag with no value', async () => {
  let got = null;
  ops.teamJoin = async (a) => { got = a; return { org: 'org_Example12345678', install_id: 'inst-1' }; };
  ops.teamSync = async () => ({ policy: { status: 'updated', version: 1 } });
  const r = await capture(() => runTeamCommand(['team', 'join', 'znj_' + 'f'.repeat(32), '--agent']));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(got.agent, undefined);
});

test('managed-config is handed over to its own command, with its own errors and exit codes', async () => {
  let r = await capture(() => runTeamCommand(['team', 'managed-config', '--json', '--agent', 'claude-code', '--os', 'linux']));
  assert.strictEqual(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.schema, 1);
  assert.ok(Array.isArray(j.files) && j.files.length > 0);
  r = await capture(() => runTeamCommand(['team', 'managed-config', '--agent', 'no-such-agent']));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /^zn team managed-config: /);
  assert.strictEqual(closed, 0, 'it never needs the vault');
});

test('status --json on a joined machine is valid JSON with the documented keys', async () => {
  ops.teamInfo = async () => ({ joined: true, org: 'org_Example12345678', org_name: null, install_id: 'inst-9', api_base: 'https://team.example.com', revoked_at: null, policy: { state: 'active', version: 3, expires_at: '2099-01-01T00:00:00.000Z' } });
  const r = await capture(() => runTeamCommand(['team', 'status', '--json']));
  assert.strictEqual(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(j), ['joined', 'vault', 'org', 'org_name', 'install_id', 'api_base', 'revoked_at', 'policy', 'upload', 'join_pending', 'last_sync', 'revocation_pending', 'revocations_dropped']);
  assert.strictEqual(j.vault, 'unlocked');
  assert.deepStrictEqual(j.policy, { state: 'active', version: 3, expires_at: '2099-01-01T00:00:00.000Z', change: null });
  assert.ok(r.stdout.endsWith('\n'));
});

test('a vault that reports it has left the organization shows as not joined', async () => {
  ops.teamInfo = async () => ({ joined: false });
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^Not in a zn organization\./);
});
