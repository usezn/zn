'use strict';
/* Block and error messages a person reads: plain words, the next step, no
 * internal codes or token names. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { znCommand, znOnPath, PACKAGE_VERSION } = require('../lib/zn-command');
const { humanError, CODES } = require('../lib/errors');
const { decidePrompt } = require('../lib/hooks/runner');
const { dispatch } = require('../lib/broker/cli');
const { createClient } = require('../lib/vault/client');

const NPX = 'npx -y zn-gate@' + PACKAGE_VERSION;
const UNLOCK_RE = /(zn|npx -y zn-gate@\S+) unlock/;

function writeFile(dir, name, mode) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\necho zn\n');
  fs.chmodSync(p, mode);
  return p;
}

// An executable zn for the PATH tests: on Windows a program needs a PATHEXT
// extension (zn.cmd); elsewhere the executable bit.
const WIN = process.platform === 'win32';
const PATHEXT = '.COM;.EXE;.BAT;.CMD';
function writeZn(dir) {
  if (WIN) {
    const p = path.join(dir, 'zn.cmd');
    fs.writeFileSync(p, '@echo zn\r\n');
    return p;
  }
  return writeFile(dir, 'zn', 0o755);
}
function pathEnv(PATH) {
  return WIN ? { PATH, PATHEXT } : { PATH };
}

function deps(spans = []) {
  return { engine: () => ({ scan: () => spans }), vault: async () => null, detectors: () => [] };
}

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

// A pattern or exact span over the AWS key in this prompt.
const AWS_PROMPT = 'my key AKIAIOSFODNN7EXAMPLE is in the file';
function awsSpan(extra) {
  const start = AWS_PROMPT.indexOf('AKIA');
  return Object.assign({ start, end: start + 20, type: 'AWS_KEY', source: 'pattern' }, extra);
}
async function promptFor(spans) {
  return decidePrompt({ event: 'user_prompt', input: { prompt: AWS_PROMPT } }, deps(spans), 'claude-code');
}

test('znCommand: plain zn when zn is an executable on PATH, npx with this version when not', (t) => {
  const withZn = tempDir(t, 'zn-path-yes-');
  writeZn(withZn);
  const without = tempDir(t, 'zn-path-no-');
  if (process.platform !== 'win32') {
    // A file that is not executable is not a program to run.
    writeFile(without, 'zn', 0o644);
    assert.equal(znOnPath({ PATH: without }), false);
  }
  assert.equal(znCommand('env shadow .env', { env: pathEnv(withZn) }), 'zn env shadow .env');
  assert.equal(znCommand('unlock', { env: pathEnv(without) }), NPX + ' unlock');
  assert.equal(znCommand('env shadow .env', { env: pathEnv('') }), NPX + ' env shadow .env');
});

test('znCommand: a relative PATH entry is ignored, even when zn sits in the current folder', (t) => {
  const dir = tempDir(t, 'zn-path-rel-');
  writeZn(dir);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(znOnPath(pathEnv('.')), false);
    assert.equal(znOnPath(pathEnv('' + path.delimiter + '.')), false);
    assert.equal(znCommand('unlock', { env: pathEnv('.') }), NPX + ' unlock');
    assert.equal(znCommand('unlock', { env: pathEnv('.' + path.delimiter + dir) }), 'zn unlock');
  } finally {
    process.chdir(cwd);
  }
});

test('znCommand: Windows finds zn.cmd through PATHEXT and not an extensionless shim',
  { skip: process.platform !== 'win32' && 'PATHEXT lookup only applies on Windows' }, (t) => {
    const dir = tempDir(t, 'zn-path-win-');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    writeFile(dir, 'zn', 0o644);
    assert.equal(znOnPath(env), false);
    fs.writeFileSync(path.join(dir, 'zn.cmd'), '@echo zn\r\n');
    assert.equal(znOnPath(env), true);
    assert.equal(znCommand('unlock', { env }), 'zn unlock');
  });

test('humanError: the plain unlock steps only when the vault is not running', () => {
  const notRunning = Object.assign(new Error('vault is locked; run `zn unlock`'), { code: CODES.LOCKED, vaultNotRunning: true });
  const text = humanError(notRunning, {});
  assert.match(text, new RegExp('^Your secret vault is locked\\. Unlock it in this terminal with: ' + UNLOCK_RE.source + '\\. Then run this command again\\.$'));
  assert.doesNotMatch(text, /passphrase|ZN_|irreversib|marker|broker/);
});

test('humanError: other vault failures keep their own detail under a plain lead', () => {
  const integrity = Object.assign(new Error('vault file secrets.age failed its integrity check: it was edited'), { code: CODES.LOCKED });
  assert.equal(humanError(integrity, {}), 'zn could not use your secret vault: vault file secrets.age failed its integrity check: it was edited');
  assert.doesNotMatch(humanError(integrity, {}), /Unlock it/);
});

test('client: a vault with no running daemon gives the plain unlock steps', async (t) => {
  const home = tempDir(t, 'zn-home-');
  const saved = process.env.ZN_HOME;
  process.env.ZN_HOME = home;
  const c = createClient({});
  try {
    await assert.rejects(c.status(), (e) => {
      assert.equal(e.code, 'ZN_LOCKED');
      assert.equal(e.vaultNotRunning, true);
      assert.match(humanError(e, {}), new RegExp('^Your secret vault is locked\\. Unlock it in this terminal with: ' + UNLOCK_RE.source + '\\. Then run this command again\\.$'));
      return true;
    });
  } finally {
    c.close();
    if (saved === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = saved;
  }
});

test('humanError: the code is shown only with ZN_VERBOSE=1 or DEBUG', () => {
  const err = Object.assign(new Error('nope'), { code: CODES.POLICY_DENIED });
  assert.equal(humanError(err, { ZN_VERBOSE: '1' }), '[ZN_POLICY_DENIED] Not allowed: nope');
  assert.equal(humanError(err, { DEBUG: '1' }), '[ZN_POLICY_DENIED] Not allowed: nope');
  assert.equal(humanError(err, { ZN_VERBOSE: '0' }), 'Not allowed: nope');
  assert.equal(humanError(Object.assign(new Error('secret X is missing'), { code: CODES.NOT_FOUND }), {}), 'Not found: secret X is missing');
  assert.equal(humanError(new Error('plain failure'), {}), 'plain failure');
});

test('CLI: refusing to print a secret says what to do instead, without the code', async () => {
  const out = sink();
  const err = sink();
  const code = await dispatch('secret', ['get', 'DB_PASSWORD'], { stdout: out, stderr: err, env: {}, cwd: process.cwd() });
  assert.equal(code, 77);
  assert.match(err.text(), /^zn secret: Not allowed: zn does not print secret values\. To use one in a command, run: /);
  assert.match(err.text(), /run --secrets NAME -- <command>/);
  assert.doesNotMatch(err.text(), /ZN_|marker|\[/);
});

test('prompt block names the secret, gives the next step and the marker to use', async () => {
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt: 'DB_PASSWORD=sunshine2024, can you connect?' } }, deps(), 'claude-code');
  assert.equal(d.decision, 'deny');
  assert.match(d.message, /contains a secret \(DB_PASSWORD\)\. Save it in your vault instead: .*secret set DB_PASSWORD, then ask your agent to use it \(as __ZN_DB_PASSWORD__\)\.$/);
  assert.doesNotMatch(d.message, /\(SECRET\)|marker/);
});

test('prompt block uses a readable kind when no name is known', async () => {
  const d = await promptFor([awsSpan()]);
  assert.equal(d.decision, 'deny');
  assert.match(d.message, /contains a secret \(an AWS key\)/);
  assert.match(d.message, /secret set AWS_KEY, then ask your agent to use it \(as __ZN_AWS_KEY__\)/);
  assert.doesNotMatch(d.message, /\(SECRET\)|AWS KEY/);
});

test('prompt block capitalises known brands and acronyms only', async () => {
  const github = await promptFor([awsSpan({ type: 'GITHUB_TOKEN' })]);
  assert.match(github.message, /\(a GitHub token\)/);
  const openai = await promptFor([awsSpan({ type: 'OPENAI_KEY' })]);
  assert.match(openai.message, /\(an OpenAI key\)/);
  const generic = await promptFor([awsSpan({ type: 'SECRET' })]);
  assert.match(generic.message, /\(a secret\)/);
  assert.match(generic.message, /secret set MY_SECRET/);
});

test('prompt block: a JSON-style key is shown in upper case', async () => {
  const d = await promptFor([awsSpan({ name: 'db_password', source: 'exact' })]);
  assert.match(d.message, /contains a secret \(DB_PASSWORD\)/);
  assert.match(d.message, /secret set DB_PASSWORD/);
});

test('prompt block: a name over 64 characters falls back to the kind; 64 is kept', async () => {
  const long = await promptFor([awsSpan({ name: 'A'.repeat(65), source: 'exact' })]);
  assert.match(long.message, /contains a secret \(an AWS key\)/);
  assert.doesNotMatch(long.message, /AAAA/);
  const max = await promptFor([awsSpan({ name: 'A'.repeat(64), source: 'exact' })]);
  assert.match(max.message, new RegExp('contains a secret \\(' + 'A'.repeat(64) + '\\)'));
});
