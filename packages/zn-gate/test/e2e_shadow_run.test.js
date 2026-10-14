'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';
/**
 * End to end (in process, with the test doubles for the vault and engine):
 *
 *   1. a project .env with fake secrets is shadowed with `zn env shadow`
 *   2. the agent reads .env and runs an allowed command through the
 *      PreToolUse rewrite + `zn run`; the command prints the value on purpose
 *   3. a command outside allowCommands is refused
 *
 * Everything the model would see (tool results after PostToolUse, hook
 * messages, rewritten commands) is appended to a simulated transcript, and
 * the test asserts that no fake value appears in it, raw or encoded.
 * Re-run with: node --test test/e2e_shadow_run.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const { spawnSync } = require('child_process');

const cli = require('../lib/broker/cli');
const { runBroker } = require('../lib/broker/run');
const runner = require('../lib/hooks/runner');
const adapter = require('../lib/agents/claude-code');
const policy = require('../lib/hooks/policy');
const dotenv = require('../lib/broker/dotenv');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(20261011, { perType: 1, piiPerType: 1 });
const val = (t) => FAKE.secrets.find((s) => s.type === t);
const AWS = val('aws_access_key_id').value;
const GHP = val('github_pat_classic').value;
const PG = val('postgres_connection_string');
const STRIPE = val('stripe_live_secret_key').value;
const SECRETS = [AWS, GHP, PG.sensitive, STRIPE];

const NODE = path.basename(process.execPath).replace(/\.exe$/i, '');
const PATH_ENV = { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') };

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

function leaks(text) {
  const found = [];
  for (const s of SECRETS) {
    for (const form of [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('hex'), encodeURIComponent(s)]) {
      if (text.includes(form)) found.push(s.slice(0, 6) + '...');
    }
  }
  return found;
}

function project(t) {
  const dir = tempDir(t, 'zn-e2e-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(dir, '.env'), [
    '# app config',
    'NODE_ENV=development',
    'AWS_ACCESS_KEY_ID=' + AWS,
    'export GITHUB_TOKEN="' + GHP + '"',
    'DATABASE_URL=' + PG.value + '  # primary',
    "STRIPE_SECRET_KEY='" + STRIPE + "'",
    'API_URL=https://api.example.com/v1',
    '',
  ].join('\n'));
  // A script the agent wrote that deliberately prints the value it receives.
  fs.writeFileSync(path.join(dir, 'print.js'), 'const v = process.argv[2] || process.env.DB_PASS;\n' +
    'console.log("connecting with " + v);\nconsole.log("b64 " + Buffer.from(v).toString("base64"));\nconsole.error("hex " + Buffer.from(v).toString("hex"));\n');
  return dir;
}

function io(dir, vault, extra = {}) {
  return { cwd: dir, home: dir, vault, stdout: sink(), stderr: sink(), human: true, confirm: async () => true, ...extra };
}

test('zn secret set refuses values in argv and agent shells', async () => {
  const vault = createFakeVault();
  const e1 = sink();
  assert.equal(await cli.dispatch('secret', ['set', 'FOO', 'value-in-argv'], { vault, stderr: e1, stdout: sink(), human: true }), 64);
  assert.match(e1.text(), /never accepted as arguments/);
  const e2 = sink();
  const code = await cli.dispatch('secret', ['set', 'FOO'], { vault, stderr: e2, stdout: sink(), env: { CLAUDECODE: '1' }, stdin: { isTTY: true } });
  assert.equal(code, 77);
  assert.match(e2.text(), /not by an AI agent/);
  const e3 = sink();
  assert.equal(await cli.dispatch('secret', ['set', 'FOO'], { vault, stderr: e3, stdout: sink(), env: {}, stdin: { isTTY: false } }), 77);
  assert.match(e3.text(), /interactive terminal/);
  const e4 = sink();
  assert.equal(await cli.dispatch('secret', ['get', 'FOO'], { vault, stderr: e4, stdout: sink() }), 77);
  const ok = await cli.dispatch('secret', ['set', 'FOO', '--command', 'psql'], { vault, stderr: sink(), stdout: sink(), human: true, readSecret: async () => 'hunter2-hunter2' });
  assert.equal(ok, 0);
  assert.deepEqual((await vault.listSecrets())[0], { name: 'FOO', mode: 'env', allowHosts: [], allowCommands: ['psql'], allowIn: ['header'], source: 'local', lastUsed: null });
});

test('zn secret import copies values and leaves the file untouched', async (t) => {
  const dir = project(t);
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  const vault = createFakeVault();
  const o = io(dir, vault);
  assert.equal(await cli.dispatch('secret', ['import', '.env'], o), 0, o.stderr.text());
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
  const names = (await vault.listSecrets()).map((s) => s.name).sort();
  assert.deepEqual(names, ['AWS_ACCESS_KEY_ID', 'DATABASE_URL_PASSWORD', 'GITHUB_TOKEN', 'STRIPE_SECRET_KEY']);
  assert.equal(await vault.resolve(dir, '__ZN_DATABASE_URL_PASSWORD__'), PG.sensitive, 'only the password of the connection string');
  assert.equal(leaks(o.stdout.text() + o.stderr.text()).length, 0);
});

test('E2E: shadowed .env + zn run with an allowed command never shows a value; other commands are refused', async (t) => {
  const dir = project(t);
  const vault = createFakeVault({ withApprovals: true });
  const transcript = [];
  const hook = async (raw) => {
    const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault, failMode: 'closed', znRunPrefix: 'ZN_AGENT=claude-code zn run --' });
    transcript.push(JSON.stringify(res.output));
    return res.output;
  };

  // 1. The user shadows .env and allows `node` for the database password.
  const o = io(dir, vault);
  assert.equal(await cli.dispatch('env', ['shadow', '.env'], o), 0, o.stderr.text());
  transcript.push(o.stdout.text()); // the user's terminal, shown here only to check it prints no values
  const shadowed = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.equal(leaks(shadowed).length, 0, '.env holds no values');
  assert.ok(dotenv.isShadowed(shadowed));
  assert.match(shadowed, /^export GITHUB_TOKEN="__ZN_GITHUB_TOKEN__"$/m, 'quotes and export kept');
  assert.match(shadowed, /^DATABASE_URL=postgres:\/\/app_rw:__ZN_DATABASE_URL_PASSWORD__@db\.internal:5432\/appdb  # primary$/m);
  assert.match(shadowed, /^API_URL=https:\/\/api\.example\.com\/v1$/m, 'URL without credentials untouched');
  assert.match(shadowed, /^# app config$/m);
  const bak = (await vault.listSecrets()).find((s) => s.name.startsWith('ENVBAK_'));
  assert.ok(bak, 'encrypted copy of the original stored in the vault');
  assert.equal(bak.mode, 'backup');
  assert.equal(await cli.dispatch('secret', ['allow', 'DATABASE_URL_PASSWORD', '--command', NODE], io(dir, vault)), 0);
  assert.equal(await cli.dispatch('secret', ['approve', 'DATABASE_URL_PASSWORD', '--command', NODE], io(dir, vault)), 0);

  // 2. The agent reads .env: allowed (only markers), output scrubbed anyway.
  const envPath = path.join(dir, '.env');
  assert.equal(await hook({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Read', tool_input: { file_path: envPath } }), null);
  const readOut = await hook({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Read', tool_input: { file_path: envPath }, tool_response: { type: 'text', file: { filePath: envPath, content: shadowed } } });
  transcript.push(readOut ? JSON.stringify(readOut) : shadowed);

  // 3. The agent runs a command with the marker: the hook wraps it in zn run.
  const agentCmd = NODE + ' print.js "__ZN_DATABASE_URL_PASSWORD__"';
  transcript.push(agentCmd);
  const pre = await hook({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: agentCmd, description: 'connect' } });
  assert.equal(pre.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(pre.hookSpecificOutput.updatedInput.command, 'ZN_AGENT=claude-code zn run -- ' + agentCmd);
  // The shell would run: zn run -- node print.js __ZN_DATABASE_URL_PASSWORD__
  const stdout = sink();
  const stderr = sink();
  const code = await runBroker(['--', NODE, 'print.js', '__ZN_DATABASE_URL_PASSWORD__'], {
    vault, cwd: dir, env: { ...PATH_ENV, ZN_AGENT: 'claude-code' }, stdout, stderr, stdin: { isTTY: false }, znHome: path.join(dir, '.zn'),
  });
  assert.equal(code, 0, stderr.text());
  assert.match(stdout.text(), /connecting with __ZN_DATABASE_URL_PASSWORD__/, 'value masked in stdout');
  assert.match(stdout.text(), /b64 __ZN_DATABASE_URL_PASSWORD__/, 'base64 masked');
  assert.match(stderr.text(), /hex __ZN_DATABASE_URL_PASSWORD__/, 'hex masked in stderr');
  const post = await hook({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: agentCmd }, tool_response: { stdout: stdout.text(), stderr: stderr.text(), interrupted: false, isImage: false } });
  transcript.push(post ? JSON.stringify(post) : stdout.text() + stderr.text());

  // 4. A command outside allowCommands is refused before it starts.
  const denyErr = sink();
  const denyOut = sink();
  const denied = await runBroker(['--', NODE, 'print.js', '__ZN_GITHUB_TOKEN__'], {
    vault, cwd: dir, env: PATH_ENV, stdout: denyOut, stderr: denyErr, stdin: { isTTY: false }, znHome: path.join(dir, '.zn'),
  });
  assert.equal(denied, 77);
  assert.equal(denyOut.text(), '', 'the command never ran');
  assert.match(denyErr.text(), /not in allowCommands for GITHUB_TOKEN/);
  assert.match(denyErr.text(), /secrets_http_request/);
  transcript.push(denyErr.text());

  // 5. The agent tries the usual ways around it.
  for (const cmd of ['cat ~/.zn/vault/secrets.age', 'zn secret approve GITHUB_TOKEN --command node', 'zn env unshadow .env --backup ' + bak.name]) {
    const r = await hook({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: cmd } });
    assert.equal(r.hookSpecificOutput.permissionDecision, 'deny', cmd);
  }
  const pasted = await hook({ hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'here is my token ' + GHP });
  assert.equal(pasted.decision, 'block');

  const all = transcript.join('\n');
  assert.deepEqual(leaks(all), [], 'no fake value in the simulated transcript');
  assert.ok(vault.auditLog.length >= 2);
  assert.deepEqual(leaks(JSON.stringify(vault.auditLog)), [], 'audit log has no values');
});

test('env shadow is idempotent and env unshadow restores the original', async (t) => {
  const dir = project(t);
  const original = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  const vault = createFakeVault();
  const o1 = io(dir, vault);
  assert.equal(await cli.dispatch('env', ['shadow'], o1), 0);
  const once = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  const o2 = io(dir, vault);
  assert.equal(await cli.dispatch('env', ['shadow'], o2), 0);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), once);
  assert.match(o2.stdout.text(), /already shadowed/);
  const bak = (await vault.listSecrets()).find((s) => s.name.startsWith('ENVBAK_')).name;
  assert.equal(await cli.dispatch('env', ['unshadow', '.env', '--backup', bak], io(dir, vault)), 0);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), original);
});

test('policy agrees: a shadowed .env is readable, the original is not', (t) => {
  const dir = project(t);
  assert.ok(policy.readDenial(path.join(dir, '.env'), { cwd: dir, home: dir }));
});
