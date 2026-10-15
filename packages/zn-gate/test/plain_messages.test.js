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
const { decidePrompt, decidePre } = require('../lib/hooks/runner');
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

test('PowerShell refusals: the reason in plain words and one next step', () => {
  const policy = require('../lib/hooks/policy');
  const opts = { nodePath: 'C:/n/node.exe', runJs: 'C:/z/run.js', agent: 'claude-code' };
  const cases = [
    ['Get-Content a.txt | Out-File __ZN_GH__', /uses a pipeline, a variable or a script block/],
    ['Get-Content __ZN_GH__', /"Get-Content" is a PowerShell command, not a program/],
    ['./deploy.ps1 __ZN_GH__', /runs a PowerShell script \(\.ps1\)/],
    ['tool+x __ZN_GH__', /does not start with a plain program name/],
  ];
  for (const [cmd, reason] of cases) {
    const r = policy.wrapPowerShell(cmd, opts);
    assert.equal(r.ok, false, cmd);
    assert.match(r.reason, reason, cmd);
    assert.match(r.reason, /Next step: start the command with the program name/, cmd);
    assert.doesNotMatch(r.reason, /cannot be rewritten|cmdlet|could not identify|scrubber/, cmd);
  }
});

test('real refusals from the vault code carry a specific next step', async (t) => {
  const keychain = require('../lib/vault/keychain');
  const home = tempDir(t, 'zn-home-next-');
  const saved = process.env.ZN_HOME;
  process.env.ZN_HOME = home;
  try {
    await assert.rejects(keychain.loadIdentity({}), (e) => {
      assert.equal(e.code, 'ZN_NOT_FOUND');
      assert.equal(humanError(e, {}), 'Not found: vault not initialised. Next step: run zn unlock once in your own terminal to create it, or, if you are an agent, ask the user to do it.');
      return true;
    });
    await assert.rejects(keychain.storeIdentity('not-an-identity', { backend: 'passphrase' }), (e) => {
      assert.equal(e.code, 'ZN_POLICY_DENIED');
      assert.equal(humanError(e, {}), 'Not allowed: not an age X25519 identity. Next step: paste the full identity line, which starts with AGE-SECRET-KEY-1.');
      return true;
    });
  } finally {
    if (saved === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = saved;
  }
});

test('MCP notice: a stored secret cannot go to this server; the next step is the web-request tool', async () => {
  const ev = { event: 'pre_tool', tool: 'mcp', mcp: { server: 'github' }, input: { args: { text: AWS_PROMPT } }, cwd: process.cwd() };
  const d = await decidePre(ev, deps([awsSpan()]), 'claude-code', { home: process.cwd() });
  assert.equal(d.decision, 'deny');
  assert.match(d.message, /^zn: this call would send a secret \(an AWS key\) to the MCP server github, so zn blocked it\. A stored secret cannot be passed to this server\. Next step: for a web request, use the secrets_http_request tool of the zn "secrets" MCP server, which sends the stored value itself; do not put the value in this call\.$/);
});

test('Monitor notices: WebSocket, placeholders and the allowed monitor', async () => {
  const opts = { nodePath: '/usr/bin/node', home: process.cwd() };
  const cwd = process.cwd();
  const ws = await decidePre({ event: 'pre_tool', tool: 'monitor', input: {}, raw: { tool_input: { ws: { url: 'wss://x' } } }, cwd }, deps(), 'claude-code', opts);
  assert.equal(ws.decision, 'deny');
  assert.match(ws.message, /^zn: a WebSocket monitor sends its data to the model without the secret check\. Next step: use a monitor that runs a command instead, because zn checks the output of commands\.$/);

  const marked = await decidePre({ event: 'pre_tool', tool: 'monitor', input: { command: 'curl __ZN_GH__' }, raw: { tool_input: { command: 'curl __ZN_GH__' } }, cwd }, deps(), 'claude-code', opts);
  assert.equal(marked.decision, 'deny');
  assert.match(marked.message, /^zn: a monitor cannot use secret placeholders \(such as __ZN_NAME__\)\. Next step: run the command with the Bash tool instead; zn fills in the placeholders there\.$/);

  const ok = await decidePre({ event: 'pre_tool', tool: 'monitor', input: { command: 'tail -f app.log' }, raw: { tool_input: { command: 'tail -f app.log' } }, cwd }, deps(), 'claude-code', opts);
  assert.equal(ok.decision, 'ask');
  assert.match(ok.message, /^zn: this monitor's output is checked on this computer before the model sees it\. Secret values are replaced with placeholders such as __ZN_AWS_KEY_1__\.$/);
});
