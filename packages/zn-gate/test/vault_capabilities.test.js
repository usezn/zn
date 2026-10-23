'use strict';
/*
 * What the vault daemon checks before it answers. The context of a request
 * (a destination of the hooks, a purpose of the broker, an agent or tool name)
 * is declared by the caller and is not proved; the daemon checks it against
 * what it holds: the restoration table, the secret's mode, the commands,
 * executables, hosts and places the user allowed, and the organization
 * policy. A request that names no context gets nothing. Masking runs in the
 * daemon (positions and names come back, never values). Real daemon, fake
 * values.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-caps-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const { createClient } = require('../lib/vault/client');
const { isOutdatedVault } = require('../lib/vault/cli');
const engine = require('../lib/scrub/engine');
const exe = require('../lib/exe');
const cli = require('../lib/broker/cli');
const { runBroker } = require('../lib/broker/run');
const { Writable } = require('stream');

const POSIX = process.platform !== 'win32';
const PROJECT = path.join(HOME, 'project');
const V = {
  proxy: 'fake-proxy-' + 'p'.repeat(24),
  env: 'fake-env-' + 'e'.repeat(24),
  file: 'fake-file-' + 'f'.repeat(24),
  backup: 'API_TOKEN=fake-backup-' + 'b'.repeat(24) + '\n',
};
const BACKUP = 'ENVBAK_X0A1B2C3DD202610230001';
const REAL_NODE = fs.realpathSync(process.execPath);
const NODE_NAME = path.basename(process.execPath).replace(/\.exe$/i, '');

const confirmations = [];
let answer = true;
const confirm = async (req) => { confirmations.push(req); return answer; };

let srv = null;
let vault = null;

const auditRecords = () => fs.readFileSync(path.join(process.env.ZN_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const denied = (e) => e && e.code === 'ZN_POLICY_DENIED';
const sink = () => {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
};

test.before(async () => {
  fs.mkdirSync(path.join(PROJECT, '.git'), { recursive: true });
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  srv = await daemon.serve({ identity: created.identity, ttlMs: 600000, idleMs: 600000, confirm, teamSyncMs: 0 });
  vault = createClient({});
  await vault.setSecret('API_TOKEN', V.proxy, { mode: 'proxy', allowHosts: ['api.example.com'] });
  await vault.setSecret('DB_PASS', V.env, { mode: 'env', allowCommands: [NODE_NAME] });
  await vault.setSecret('CERT_PEM', V.file, { mode: 'file' });
  await vault.setSecret(BACKUP, V.backup, { mode: 'backup' });
});

test.after(async () => {
  if (vault) vault.close();
  if (srv) await srv.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('resolve with no destination and no purpose is refused, and the attempt is audited', async () => {
  const detected = await vault.mapToken(PROJECT, 'EMAIL', 'fake.user@example.org');
  for (const token of [detected, '__ZN_API_TOKEN__', '__ZN_DB_PASS__', '__ZN_CERT_PEM__']) {
    await assert.rejects(vault.resolve(PROJECT, token), denied, token);
    // Naming an agent or a tool is no context.
    await assert.rejects(vault.resolve(PROJECT, token, { agent: 'claude-code', tool: 'Bash' }), denied, token);
    await assert.rejects(vault.resolve(PROJECT, token, { withPolicy: true }), denied, token);
  }
  assert.ok(auditRecords().some((r) => r.secret === 'DB_PASS' && r.decision === 'deny' && r.reason === 'policy:no_context' && r.mode === 'resolve'));
  assert.ok(!JSON.stringify(auditRecords()).includes(V.env));
});

test('a destination or purpose the vault does not know is refused', async () => {
  for (const opts of [{ destination: 'write_local' }, { destination: 'anything' }, { purpose: 'anything' }, { purpose: 'mask' }, { purpose: 'run' }, { purpose: 'zn-cloud-key' }, { destination: 'bash_local', purpose: 'nope' }]) {
    await assert.rejects(vault.resolve(PROJECT, '__ZN_DB_PASS__', opts), denied, JSON.stringify(opts));
  }
  // The purpose of the zn-gate key opens nothing else.
  await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', { purpose: 'zn-cloud-key' }), denied);
});

test('the daemon applies the engine\'s restoration table, and never restores for the assistant', () => {
  const daemonTable = JSON.parse(JSON.stringify(daemon.DESTINATION_POLICY));
  const engineTable = JSON.parse(JSON.stringify(engine.POLICY));
  const { assistant, ...otherDaemon } = daemonTable;
  const { assistant: engineAssistant, ...otherEngine } = engineTable;
  assert.deepStrictEqual(otherDaemon, otherEngine);
  assert.strictEqual(engineAssistant.named, 'restore');
  assert.deepStrictEqual(assistant, { detected: 'not_restored', named: 'not_restored' });
});

test('a named secret is not restored into a local command, whoever the request says it is', async () => {
  for (const claim of [{}, { agent: 'claude-code', tool: 'Bash' }, { agent: 'codex', tool: 'shell', agentTrusted: true }]) {
    await assert.rejects(vault.resolve(PROJECT, '__ZN_DB_PASS__', { destination: 'bash_local', ...claim }), denied);
  }
  for (const destination of ['bash_network', 'mcp_input', 'write_tracked']) {
    await assert.rejects(vault.resolve(PROJECT, '__ZN_DB_PASS__', { destination }), denied, destination);
  }
  const detected = await vault.mapToken(PROJECT, 'EMAIL', 'fake.user@example.org');
  assert.strictEqual(await vault.resolve(PROJECT, detected, { destination: 'bash_local' }), 'fake.user@example.org');
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_DB_PASS__', { destination: 'write_ignored', agent: 'whatever' }), V.env);
});

test('an agent or tool name grants nothing: the same request gets the same answer under any name', async () => {
  const names = [undefined, 'claude-code', 'codex', 'cursor', 'opencode', 'zn', 'admin', '', 'x'.repeat(500)];
  for (const agent of names) {
    for (const tool of [undefined, 'mcp:secrets_http_request', 'Bash', 'zn run']) {
      // a host the secret does not allow
      await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', { purpose: 'http', agent, tool, agentTrusted: true, host: 'evil.example.net', placements: ['header'] }), denied);
      // a placement it does not allow
      await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', { purpose: 'http', agent, tool, agentTrusted: true, host: 'api.example.com', placements: ['body'] }), denied);
      // a mode it is not in
      await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', { purpose: 'run', agent, tool, argv: [NODE_NAME, 'x.js'], exe: { real: REAL_NODE, fp: exe.fingerprint(REAL_NODE) } }), denied);
      await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', { purpose: 'render', agent, tool }), denied);
    }
  }
});

test('purpose http: a host and a placement the secret allows, and nothing else', async () => {
  const ok = { purpose: 'http', agent: 'claude-code', tool: 'mcp:secrets_http_request' };
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_API_TOKEN__', { ...ok, host: 'api.example.com', placements: ['header'] }), V.proxy);
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_API_TOKEN__', { ...ok, host: 'API.Example.com', placements: [] }), V.proxy);
  for (const bad of [
    { host: 'evil.example.net', placements: ['header'] },
    { host: 'sub.api.example.com', placements: ['header'] },
    { host: '', placements: ['header'] },
    { placements: ['header'] },
    { host: 'api.example.com' },
    { host: 'api.example.com', placements: 'header' },
    { host: 'api.example.com', placements: ['header', 'query'] },
    { host: 'api.example.com', placements: ['cookie'] },
  ]) {
    await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', { ...ok, ...bad }), denied, JSON.stringify(bad));
  }
  // The local setting decides: once the user widened it, the body is allowed.
  await vault.updateSecretMeta('API_TOKEN', { allowIn: ['header', 'body'] });
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_API_TOKEN__', { ...ok, host: 'api.example.com', placements: ['body'] }), V.proxy);
  // A secret with no host allowed goes nowhere; a scrubber token is not a stored secret.
  await assert.rejects(vault.resolve(PROJECT, '__ZN_DB_PASS__', { ...ok, host: 'api.example.com', placements: ['header'] }), denied);
  const detected = await vault.mapToken(PROJECT, 'EMAIL', 'fake.user@example.org');
  await assert.rejects(vault.resolve(PROJECT, detected, { ...ok, host: 'api.example.com', placements: ['header'] }), denied);
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_NOT_STORED__', { ...ok, host: 'api.example.com', placements: ['header'] }), null);
});

test('purpose render: only a file-mode secret is written to disk', async () => {
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_CERT_PEM__', { purpose: 'render', tool: 'mcp:secrets_render_file' }), V.file);
  await assert.rejects(vault.resolve(PROJECT, '__ZN_DB_PASS__', { purpose: 'render' }), denied);
  await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', { purpose: 'render' }), denied);
});

test('purpose run: an env-mode secret, a command it allows and an executable the user approved', async () => {
  const fp = exe.fingerprint(REAL_NODE);
  const run = (extra) => vault.resolve(PROJECT, '__ZN_DB_PASS__', { purpose: 'run', agent: 'claude-code', tool: 'zn run', ...extra });
  const good = { argv: [NODE_NAME, 'job.js'], exe: { real: REAL_NODE, fp } };
  // not approved yet
  await assert.rejects(run(good), denied);
  // a command the secret does not allow, whatever is approved
  await assert.rejects(run({ ...good, argv: ['python3', 'job.py'] }), denied);
  await assert.rejects(run({ ...good, argv: [] }), denied);
  await assert.rejects(run({ exe: good.exe }), denied);
  // no executable named
  await assert.rejects(run({ argv: good.argv }), denied);
  await assert.rejects(run({ argv: good.argv, exe: { real: 'relative/node', fp } }), denied);
  // the user approves the pair on the daemon's own channel
  confirmations.length = 0;
  answer = true;
  await vault.recordApproval(PROJECT, 'DB_PASS', NODE_NAME, { real: REAL_NODE, fp });
  assert.strictEqual(confirmations.length, 1);
  assert.strictEqual(await run(good), V.env);
  // another file, or the same file changed, is not the one approved
  await assert.rejects(run({ ...good, exe: { real: REAL_NODE, fp: '1:2:3:4' } }), denied);
  const other = POSIX ? fs.realpathSync('/bin/sh') : null;
  if (other && other !== REAL_NODE) await assert.rejects(run({ ...good, exe: { real: other, fp: exe.fingerprint(other) } }), denied);
});

test('zn run end to end through the real daemon: first use is confirmed, then the program gets the value', async () => {
  await vault.setSecret('RUN_PASS', 'fake-run-' + 'r'.repeat(24), { mode: 'env', allowCommands: [NODE_NAME] });
  confirmations.length = 0;
  answer = true;
  const stdout = sink();
  const stderr = sink();
  const code = await runBroker(['--secrets', 'RUN_PASS', '--', NODE_NAME, '-e', 'console.log(process.env.RUN_PASS === "fake-run-" + "r".repeat(24) ? "match" : "nomatch")'], {
    vault, cwd: PROJECT, env: { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') },
    stdout, stderr, stdin: { isTTY: false }, znHome: process.env.ZN_HOME, project: PROJECT,
  });
  assert.strictEqual(code, 0, stderr.text());
  assert.match(stdout.text(), /match/);
  assert.strictEqual(confirmations.length, 1, 'the first use was confirmed by the daemon');
  // A command the secret does not allow never reaches the daemon's value.
  const err2 = sink();
  const refused = await runBroker(['--secrets', 'RUN_PASS', '--', 'sh', '-c', 'echo $RUN_PASS'], {
    vault, cwd: PROJECT, env: { PATH: process.env.PATH }, stdout: sink(), stderr: err2, stdin: { isTTY: false }, znHome: process.env.ZN_HOME, project: PROJECT,
  });
  assert.notStrictEqual(refused, 0);
});

test('no request reads a value out: exactValues is gone, masking returns positions and names only', async () => {
  // The old call, with every claim a caller can make, finds no operation.
  for (const args of [[PROJECT], [PROJECT, {}], [PROJECT, { purpose: 'mask' }], [PROJECT, { purpose: 'mask', agent: 'claude-code', tool: 'Read' }]]) {
    await assert.rejects(vault.call('exactValues', args), (e) => denied(e) && /unknown operation/.test(e.message));
  }
  const info = await vault.maskInfo(PROJECT, { agent: 'claude-code', tool: 'Read' });
  assert.ok(info.names.includes('DB_PASS') && info.names.includes('API_TOKEN') && info.count >= 8 && info.longest >= V.env.length);
  assert.ok(!info.names.includes(BACKUP), 'backups are not looked for');
  const everything = JSON.stringify(info);
  for (const v of Object.values(V)) assert.ok(!everything.includes(v));
  const text = 'a ' + V.env + ' b ' + Buffer.from(V.proxy).toString('base64') + ' c ' + Buffer.from(V.file).toString('hex');
  const [spans, none] = await vault.maskSpans(PROJECT, [text, 'nothing to see here at all'], { agent: 'claude-code', tool: 'Read' });
  assert.deepStrictEqual([...new Set(spans.map((s) => s.name))].sort(), ['API_TOKEN', 'CERT_PEM', 'DB_PASS']);
  assert.ok(spans.some((s) => s.name === 'DB_PASS' && text.slice(s.start, s.end) === V.env));
  assert.deepStrictEqual(none, []);
  const wire = JSON.stringify(spans);
  for (const v of Object.values(V)) assert.ok(!wire.includes(v), 'a value reached the answer');
  assert.ok(spans.every((s) => Object.keys(s).every((k) => ['start', 'end', 'type', 'source', 'name', 'variant', 'vault'].includes(k))));
  // a secret the organization denies, the cloud key and proxy-mode secrets are matched too: masking must hide them
  await vault.setSecret('ZN_CLOUD_API_KEY', 'fake-cloud-' + 'c'.repeat(24), { mode: 'proxy', allowHosts: ['api.usezn.com'] });
  const [cloud] = await vault.maskSpans(PROJECT, ['k fake-cloud-' + 'c'.repeat(24)]);
  assert.ok(cloud.some((s) => s.name === 'ZN_CLOUD_API_KEY'));
  await vault.removeSecret('ZN_CLOUD_API_KEY');
  // a secret stored after the first call is matched by the next one
  await vault.setSecret('LATE_SECRET', 'fake-late-' + 'l'.repeat(24), { mode: 'env' });
  const [late] = await vault.maskSpans(PROJECT, ['x fake-late-' + 'l'.repeat(24)]);
  assert.ok(late.some((s) => s.name === 'LATE_SECRET'));
  await vault.removeSecret('LATE_SECRET');
  const [gone] = await vault.maskSpans(PROJECT, ['x fake-late-' + 'l'.repeat(24)]);
  assert.deepStrictEqual(gone, []);
  // bad requests
  await assert.rejects(vault.call('maskSpans', [PROJECT, 'not an array']), denied);
  await assert.rejects(vault.call('maskSpans', [PROJECT, [1]]), denied);
  await assert.rejects(vault.call('maskSpans', [PROJECT, new Array(5000).fill('x')]), denied);
  // the calls are recorded, at most one record a minute for each agent and tool
  const grants = auditRecords().filter((r) => r.reason === 'mask_text' && r.agent === 'claude-code' && r.tool === 'Read');
  assert.strictEqual(grants.length, 1);
});

test('hooks and the streaming scrubber mask the vault\'s values through the daemon, a value split between chunks included', async () => {
  const runner = require('../lib/hooks/runner');
  const adapter = require('../lib/agents/claude-code');
  const { createStream } = require('../lib/scrub/stream');
  const hex = Buffer.from(V.file).toString('hex');
  const b64 = Buffer.from(V.env).toString('base64');
  const output = 'build ok\nkey=' + V.proxy + '\nenv ' + b64 + '\ncert ' + hex + '\ndone\n';
  const post = await runner.handle(adapter, { hook_event_name: 'PostToolUse', cwd: PROJECT, tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout: output, stderr: '', interrupted: false, isImage: false } }, { vault, failMode: 'closed' });
  const text = JSON.stringify(post.output);
  for (const leaked of [V.proxy, b64, hex]) assert.ok(!text.includes(leaked), 'a value reached the model');
  assert.ok(text.includes('__ZN_API_TOKEN__'), text.slice(0, 300));
  // a pasted vault secret stops the prompt
  const prompt = await runner.handle(adapter, { hook_event_name: 'UserPromptSubmit', cwd: PROJECT, prompt: 'please use ' + V.proxy + ' for the call' }, { vault, failMode: 'closed' });
  assert.strictEqual(prompt.decision.decision, 'deny');
  assert.ok(!JSON.stringify(prompt.output).includes(V.proxy));
  // a value cut in two chunks, with the first half already past the flush timer
  const written = [];
  const stream = createStream({ ctx: { project: PROJECT, agent: 'stream', tool: 'stream', destination: 'assistant', vault, env: {}, exactFiles: false }, write: (t) => written.push(t) });
  await stream.push('x'.repeat(5000) + V.env.slice(0, 20));
  await stream.flushPartial();
  await stream.push(V.env.slice(20) + ' tail\n');
  await stream.end();
  const out = written.join('');
  assert.ok(!out.includes(V.env) && !out.includes(V.env.slice(0, 20)), 'a value, or the start of one, was written');
  assert.ok(out.includes('__ZN_DB_PASS__') && out.includes(' tail'), out.slice(-120));
});

test('resolve for the assistant is refused whatever the secret: no value goes back in front of the model', async () => {
  for (const token of ['__ZN_API_TOKEN__', '__ZN_DB_PASS__', '__ZN_CERT_PEM__']) {
    for (const claim of [{}, { agent: 'claude-code', tool: 'Read' }]) {
      await assert.rejects(vault.resolve(PROJECT, token, { destination: 'assistant', ...claim }), denied, token);
      await assert.rejects(vault.resolve(PROJECT, token, { destination: 'assistant', withPolicy: true, ...claim }), denied, token);
    }
  }
  const detected = await vault.mapToken(PROJECT, 'EMAIL', 'fake.user@example.org');
  await assert.rejects(vault.resolve(PROJECT, detected, { destination: 'assistant' }), denied);
});

test('adoptToken keeps the value inside the vault; sameSecretValue answers yes or no', async () => {
  const value = 'AKIA' + 'FAKEFAKEFAKE0000'.slice(0, 16);
  const token = await vault.mapToken(PROJECT, 'AWS_KEY', value);
  assert.strictEqual(await vault.adoptToken(PROJECT, token, 'ADOPTED_KEY', { mode: 'env', allowCommands: [NODE_NAME] }), true);
  assert.ok((await vault.listSecrets()).some((s) => s.name === 'ADOPTED_KEY' && s.mode === 'env'));
  assert.strictEqual(await vault.sameSecretValue('ADOPTED_KEY', value), true);
  assert.strictEqual(await vault.sameSecretValue('ADOPTED_KEY', value + 'x'), false);
  assert.strictEqual(await vault.sameSecretValue('NOT_STORED', value), false);
  await assert.rejects(vault.adoptToken(PROJECT, token, 'ADOPTED_KEY', {}), denied, 'an existing name is not replaced');
  await assert.rejects(vault.adoptToken(PROJECT, '__ZN_API_TOKEN__', 'ANOTHER_KEY', {}), denied, 'only scrubber tokens');
  await assert.rejects(vault.adoptToken(PROJECT, '__ZN_AWS_KEY_99__', 'ANOTHER_KEY', {}), (e) => e.code === 'ZN_NOT_FOUND');
  await assert.rejects(vault.adoptToken('/another/project', token, 'ANOTHER_KEY', {}), (e) => e.code === 'ZN_NOT_FOUND', 'tokens belong to their project');
  await vault.removeSecret('ADOPTED_KEY');
});

test('zn secret adopt works through the real daemon', async () => {
  const value = 'fake-adopt-' + 'a'.repeat(24);
  const token = await vault.mapToken(PROJECT, 'PASSWORD', value);
  const out = sink();
  const code = await cli.dispatch('secret', ['adopt', token, '--name', 'ADOPTED_PASS', '--command', NODE_NAME], { vault, cwd: PROJECT, home: HOME, human: true, stdout: out, stderr: sink() });
  assert.strictEqual(code, 0);
  assert.strictEqual(await vault.sameSecretValue('ADOPTED_PASS', value), true);
  await vault.removeSecret('ADOPTED_PASS');
});

test('readBackup gives the plain text only to a user who confirms on the vault\'s channel', async () => {
  confirmations.length = 0;
  answer = false;
  await assert.rejects(vault.readBackup(PROJECT, BACKUP, path.join(PROJECT, '.env')), denied);
  assert.strictEqual(confirmations.length, 1);
  assert.ok(confirmations[0].fields.some(([k, v]) => k === 'Backup' && v === BACKUP));
  answer = true;
  assert.strictEqual(await vault.readBackup(PROJECT, BACKUP, path.join(PROJECT, '.env')), V.backup);
  assert.ok(auditRecords().some((r) => r.reason === 'backup_read_confirmed'));
  // only the copies zn env shadow made
  confirmations.length = 0;
  for (const name of ['API_TOKEN', 'DB_PASS', 'ENVBAK_X0A1B2C3DD202610230002', 'lowercase']) {
    await assert.rejects(vault.readBackup(PROJECT, name, '.env'), (e) => e.code === 'ZN_NOT_FOUND' || denied(e), name);
  }
  assert.strictEqual(confirmations.length, 0, 'nothing was asked for a secret that is not a backup');
});

test('the vault reports the capabilities feature, and an older vault is called outdated', async () => {
  const st = await vault.status();
  assert.ok(st.features.includes('capabilities') && st.features.includes('resolve-policy'));
  assert.strictEqual(isOutdatedVault(st), false);
  assert.strictEqual(isOutdatedVault({ unlocked: true, features: ['resolve-policy'] }), true);
  assert.strictEqual(isOutdatedVault({ unlocked: true }), true);
});

test('POSIX: the daemon refuses to serve from files that are not private to its user', { skip: !POSIX }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ep-'));
  try {
    const ep = { unix: true, address: path.join(dir, 'vault.sock'), keyFile: path.join(dir, 'session.key') };
    fs.writeFileSync(ep.address, '');
    fs.writeFileSync(ep.keyFile, 'k');
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(ep.address, 0o600);
    fs.chmodSync(ep.keyFile, 0o600);
    assert.doesNotThrow(() => daemon.assertPrivateEndpoint(ep));
    fs.unlinkSync(ep.keyFile);
    assert.doesNotThrow(() => daemon.assertPrivateEndpoint(ep), 'a file that does not exist yet is fine before the daemon starts');
    assert.throws(() => daemon.assertPrivateEndpoint(ep, true), denied, 'but not once it should be there');
    fs.writeFileSync(ep.keyFile, 'k');
    fs.chmodSync(ep.keyFile, 0o600);
    fs.chmodSync(ep.keyFile, 0o640);
    assert.throws(() => daemon.assertPrivateEndpoint(ep), denied);
    fs.chmodSync(ep.keyFile, 0o600);
    fs.chmodSync(ep.address, 0o660);
    assert.throws(() => daemon.assertPrivateEndpoint(ep), denied);
    fs.chmodSync(ep.address, 0o600);
    fs.chmodSync(dir, 0o750);
    assert.throws(() => daemon.assertPrivateEndpoint(ep), denied);
    fs.chmodSync(dir, 0o700);
    fs.unlinkSync(ep.keyFile);
    fs.symlinkSync(ep.address, ep.keyFile);
    assert.throws(() => daemon.assertPrivateEndpoint(ep), denied, 'a symlink is not the session key');
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup of a .env file is read only through readBackup, whatever destination or purpose a request names', async () => {
  const token = '__ZN_' + BACKUP + '__';
  await vault.setSecret('ENV_BACKUP_ABCDEF', V.backup, { mode: 'backup' });
  const detected = await vault.mapToken(PROJECT, 'ENVTEXT', V.backup);
  const contexts = [
    { destination: 'write_ignored' }, { destination: 'write_ignored', withPolicy: true, agent: 'claude-code', tool: 'Write' },
    { destination: 'bash_local' }, { destination: 'assistant' }, { destination: 'mcp_input' }, { destination: 'bash_network' }, { destination: 'write_tracked' },
    { purpose: 'run', argv: [NODE_NAME, 'x.js'], exe: { real: REAL_NODE, fp: exe.fingerprint(REAL_NODE) } },
    { purpose: 'http', host: 'api.example.com', placements: ['header'] }, { purpose: 'render' }, { purpose: 'zn-cloud-key' },
  ];
  for (const ctx of contexts) {
    // the backup shown by listSecrets under its own name, the same text under a name of the user's choosing, and the detected value
    for (const t of [token, '__ZN_ENV_BACKUP_ABCDEF__', detected]) {
      await assert.rejects(vault.resolve(PROJECT, t, ctx), denied, t + ' ' + JSON.stringify(ctx));
    }
  }
  const records = auditRecords();
  assert.ok(records.some((r) => r.secret === BACKUP && r.decision === 'deny' && r.reason === 'policy:backup'));
  assert.ok(records.some((r) => r.secret === 'ENV_BACKUP_ABCDEF' && r.decision === 'deny' && r.reason === 'policy:backup'));
  assert.ok(!JSON.stringify(records).includes(V.backup));
  // the one way out still works, with the user's confirmation
  answer = true;
  assert.strictEqual(await vault.readBackup(PROJECT, BACKUP, path.join(PROJECT, '.env')), V.backup);
  await vault.removeSecret('ENV_BACKUP_ABCDEF');
});

test('a restore into a git-ignored file writes env and file mode secrets, never proxy ones', async () => {
  const ignored = { destination: 'write_ignored', agent: 'claude-code', tool: 'Write' };
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_DB_PASS__', ignored), V.env);
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_CERT_PEM__', ignored), V.file);
  for (const opts of [ignored, { ...ignored, withPolicy: true }]) {
    await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', opts), (e) => denied(e) && /proxy mode/.test(e.message));
  }
  // the scrubber's token for the value of a proxy secret is no way round it, for a file or a local command
  const detected = await vault.mapToken(PROJECT, 'PASSWORD', V.proxy);
  for (const destination of ['write_ignored', 'bash_local']) await assert.rejects(vault.resolve(PROJECT, detected, { destination }), (e) => denied(e) && /proxy mode/.test(e.message));
  assert.ok(auditRecords().some((r) => r.secret === 'API_TOKEN' && r.decision === 'deny' && r.reason === 'policy:proxy_mode'));
  // the same secret moved to env mode by its owner (confirmed on the vault's channel) can be restored
  answer = true;
  await vault.updateSecretMeta('API_TOKEN', { mode: 'env' });
  assert.strictEqual(await vault.resolve(PROJECT, '__ZN_API_TOKEN__', ignored), V.proxy);
  await vault.updateSecretMeta('API_TOKEN', { mode: 'proxy' });
  await assert.rejects(vault.resolve(PROJECT, '__ZN_API_TOKEN__', ignored), denied);
});

test('a vault that stops answering a scan holds the output back instead of passing it as clean', async () => {
  const runner = require('../lib/hooks/runner');
  const adapter = require('../lib/agents/claude-code');
  const flaky = new Proxy(vault, {
    get(target, prop) {
      if (prop === 'maskSpans') return async () => { throw Object.assign(new Error('closed'), { code: 'ZN_LOCKED' }); };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  await assert.rejects(engine.scanAsync('x ' + V.env + ' y', { project: PROJECT, agent: 'test', tool: 'Read', destination: 'assistant', vault: flaky, env: {}, exactFiles: false }), (e) => e.vaultFailed === true && e.code === 'ZN_LOCKED');
  for (const failMode of ['closed', 'open']) {
    const res = await runner.handle(adapter, { hook_event_name: 'PostToolUse', cwd: PROJECT, tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout: 'ok\nkey=' + V.env + '\nmore ' + V.file + '\n', stderr: '', interrupted: false, isImage: false } }, { vault: flaky, failMode });
    const text = JSON.stringify(res.output);
    assert.ok(!text.includes(V.env) && !text.includes(V.file), failMode + ': a value reached the model');
    assert.ok(res.output && text.length > 2, failMode + ': the output was replaced, not passed through');
  }
});

test('sameSecretValue is recorded and rate limited', async () => {
  const before = auditRecords().filter((r) => r.reason === 'compare').length;
  assert.strictEqual(await vault.sameSecretValue('DB_PASS', V.env), true);
  assert.strictEqual(await vault.sameSecretValue('DB_PASS', V.env + 'x'), false);
  assert.strictEqual(auditRecords().filter((r) => r.reason === 'compare').length, before + 2);
  let refused = 0;
  for (let i = 0; i < 130; i++) {
    try { await vault.sameSecretValue('DB_PASS', 'guess-' + i); } catch (e) { if (denied(e)) refused += 1; }
  }
  assert.ok(refused >= 1, 'guesses are limited');
  assert.ok(auditRecords().some((r) => r.reason === 'policy:compare_rate'));
});
