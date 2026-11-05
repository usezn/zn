'use strict';
/*
 * `zn team join -` reads one token line from standard input, and a failed team command prints one plain line.
 * Both are checked with fake values: a fake standard input stream and fake errors thrown by a fake client. The token
 * is never echoed; a "details:" line shows only with ZN_VERBOSE=1.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-stdin-'));
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
const { CODES } = require('../lib/errors');
const { znCommand } = require('../lib/zn-command');

const TOKEN = 'znj_' + 'B'.repeat(40);

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  delete process.env.ZN_VERBOSE;
  fake = {};
});

async function capture(fn) {
  const o = process.stdout.write; const e = process.stderr.write;
  let stdout = ''; let stderr = '';
  // Only the strings zn prints are kept; anything else (the test runner reports its results to its parent through
  // stdout, in bytes, and may do so while this runs) goes on to the real stream.
  process.stdout.write = (s, ...rest) => { if (typeof s !== 'string') return o.call(process.stdout, s, ...rest); stdout += s; return true; };
  process.stderr.write = (s, ...rest) => { if (typeof s !== 'string') return e.call(process.stderr, s, ...rest); stderr += s; return true; };
  try { const code = await fn(); return { code, stdout, stderr }; } finally { process.stdout.write = o; process.stderr.write = e; }
}

/** Runs `fn` with `process.stdin` replaced by a fake stream, then puts the real one back. */
async function withStdin(stream, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process, 'stdin', original); }
}

function fakeStdin(text, { tty = false } = {}) {
  const s = new PassThrough();
  s.isTTY = tty;
  if (text !== null) { if (text) s.write(text); s.end(); }
  return s;
}

/** `zn team join -` with a fake standard input; returns what the fake client got and what was printed. */
async function joinFromStdin(text, opts) {
  let joinArgs = null;
  fake.teamJoin = async (a) => { joinArgs = a; return { org: 'org_Example12345678', install_id: 'inst-0001' }; };
  fake.teamSync = async () => { throw new Error('offline'); };
  const r = await withStdin(fakeStdin(text, opts), () => capture(() => runTeamCommand(['team', 'join', '-'], { env: {} })));
  return { ...r, joinArgs };
}

const NO_TOKEN = /^\[zn\] no join token on standard input\. Pipe it in, for example: printf %s "\$TOKEN" \| zn team join -\n$/;

test('stdin: empty input is "no join token", exit 2, and nothing is sent', async () => {
  const r = await joinFromStdin('');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, NO_TOKEN);
  assert.strictEqual(r.joinArgs, null);
});

test('stdin: input with only blank lines is "no join token"', async () => {
  const r = await joinFromStdin('\n   \n\t\n');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, NO_TOKEN);
  assert.strictEqual(r.joinArgs, null);
});

test('stdin: a token with or without a trailing newline is sent without it', async () => {
  for (const text of [TOKEN + '\n', TOKEN, TOKEN + '\r\n', '  ' + TOKEN + '  \n']) {
    const r = await joinFromStdin(text);
    assert.ok(r.joinArgs, JSON.stringify(text) + ': the join was sent');
    assert.strictEqual(r.joinArgs.join_token, TOKEN, JSON.stringify(text));
  }
});

test('stdin: blank lines before the token are skipped, and only the first non-empty line is used', async () => {
  const r = await joinFromStdin('\n\n' + TOKEN + '\nznj_second\nznj_third\n');
  assert.strictEqual(r.joinArgs.join_token, TOKEN);
});

test('stdin: a very long line is read whole (it is the server that refuses it, not the reader)', async () => {
  const long = 'znj_' + 'C'.repeat(300000);
  const r = await joinFromStdin(long + '\nignored\n');
  assert.strictEqual(r.joinArgs.join_token, long);
  assert.strictEqual(r.joinArgs.join_token.length, 300004);
});

test('stdin: the token is never printed', async () => {
  const r = await joinFromStdin(TOKEN + '\n');
  assert.ok(!r.stdout.includes(TOKEN), 'not on stdout');
  assert.ok(!r.stderr.includes(TOKEN), 'not on stderr');
  assert.ok(!/shell history/.test(r.stderr), 'no "token given as an argument" note for stdin');
});

test('stdin: a stream that fails counts as no token and does not hang', async () => {
  let joinArgs = null;
  fake.teamJoin = async (a) => { joinArgs = a; return {}; };
  const s = new PassThrough();
  s.isTTY = false;
  setImmediate(() => s.destroy(new Error('read failed')));
  const r = await withStdin(s, () => capture(() => runTeamCommand(['team', 'join', '-'], { env: {} })));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, NO_TOKEN);
  assert.strictEqual(joinArgs, null);
});

test('stdin: a terminal gets one prompt line, a pipe gets none', async () => {
  const tty = await joinFromStdin(TOKEN + '\n', { tty: true });
  assert.match(tty.stderr, /^Paste the join token and press Enter:\n/);
  assert.ok(!tty.stderr.includes(TOKEN));
  const pipe = await joinFromStdin(TOKEN + '\n', { tty: false });
  assert.ok(!/Paste the join token/.test(pipe.stderr));
});

test('stdin: an argument that is not "-" does not read standard input', async () => {
  let joinArgs = null;
  fake.teamJoin = async (a) => { joinArgs = a; return { org: 'org_Example12345678', install_id: 'inst-0001' }; };
  fake.teamSync = async () => { throw new Error('offline'); };
  const stdin = fakeStdin('znj_from_stdin\n');
  await withStdin(stdin, () => capture(() => runTeamCommand(['team', 'join', TOKEN], { env: {} })));
  assert.strictEqual(joinArgs.join_token, TOKEN);
});

// --- printError, reached through a failing join ---

async function failWith(error, env) {
  fake.teamJoin = async () => { throw error; };
  if (env) Object.assign(process.env, env);
  return capture(() => runTeamCommand(['team', 'join'], { env: { ZN_TEAM_JOIN_TOKEN: TOKEN } }));
}

test('printError: an error without a code is one "[zn] " line and exit 1', async () => {
  const r = await failWith(new Error('something went wrong'));
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] something went wrong\n');
  assert.strictEqual(r.stdout, '');
});

test('printError: an error with a code prints the same plain line', async () => {
  const r = await failWith(Object.assign(new Error('the server said no'), { code: 'ZN_TEST' }));
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] the server said no\n');
});

test('printError: a "details:" line is hidden by default and shown with ZN_VERBOSE=1', async () => {
  const e = () => Object.assign(new Error('Could not connect. Try again.\ndetails: HTTP 502: bad gateway'), { code: 'ZN_TEST' });
  let r = await failWith(e());
  assert.strictEqual(r.stderr, '[zn] Could not connect. Try again.\n');
  process.env.ZN_VERBOSE = '1';
  r = await failWith(e());
  assert.strictEqual(r.stderr, '[zn] Could not connect. Try again.\n[zn] details: HTTP 502: bad gateway\n');
});

test('printError: a thrown string, and an error with an empty message, still print one line', async () => {
  let r = await failWith('plain text failure');
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] plain text failure\n');
  r = await failWith(new Error(''));
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] Error\n');
});

test('printError: a locked vault gets the unlock command, unless the message already names it', async () => {
  let r = await failWith(Object.assign(new Error('The vault is locked.'), { code: CODES.LOCKED }));
  assert.strictEqual(r.stderr, '[zn] The vault is locked; run `' + znCommand('unlock') + '`\n');
  r = await failWith(Object.assign(new Error('The vault is locked. Run zn unlock first.'), { code: CODES.LOCKED }));
  assert.strictEqual(r.stderr, '[zn] The vault is locked. Run zn unlock first.\n');
});
