'use strict';

// zn-gate reach: a read-only report of what the agents on this machine can reach.
// It names secrets and credential files, never shows a value, writes nothing,
// sends nothing and starts no hook.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { reach, report, _internal } = require('../lib/reach');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

// 30 obviously fake secret values, spread over a project .env, a second .env,
// credential files and environment variables.
const FAKES = Array.from({ length: 30 }, (_, i) => 'zn-test-fake-value-' + String(i).padStart(4, '0') + '-not-real');

function machine(t, opts = {}) {
  const home = tempDir(t, 'zn-reach-home-');
  const root = tempDir(t, 'zn-reach-proj-');
  // Only Node.js on PATH, so an agent installed on this computer is not found by the test.
  const env = { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath) };
  for (const dir of opts.found || []) fs.mkdirSync(path.join(home, dir), { recursive: true });
  for (const id of opts.agents || []) {
    getAdapter(id).install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  }
  if (opts.secrets !== false) {
    fs.writeFileSync(path.join(root, '.env'), [
      'OPENAI_API_KEY=' + FAKES[0],
      'DATABASE_URL=postgres://app:' + FAKES[1] + '@db.example.invalid/app',
      'STRIPE_SECRET=' + FAKES[2],
      'GITHUB_TOKEN="' + FAKES[3] + '"',
      'export AWS_SECRET_ACCESS_KEY=' + FAKES[4],
      'SHADOWED_TOKEN=__ZN_SHADOWED_TOKEN__',
      'APP_NAME=example',
      'API_URL=https://api.example.invalid',
      ...FAKES.slice(5, 15).map((v, i) => 'SERVICE_' + i + '_KEY=' + v),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(root, '.env.local'), FAKES.slice(15, 20).map((v, i) => 'LOCAL_' + i + '_PASSWORD=' + v).join('\n') + '\n');
    fs.writeFileSync(path.join(root, '.env.example'), 'OPENAI_API_KEY=your-key-here-please\n');
    fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key = ' + FAKES[20] + '\n');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'FAKE KEY ' + FAKES[21] + '\n');
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 FAKEPUBLIC\n');
    fs.writeFileSync(path.join(home, '.ssh', 'deploy_key'), 'FAKE KEY ' + FAKES[22] + '\n');
    fs.writeFileSync(path.join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=' + FAKES[23] + '\n');
    FAKES.slice(24, 30).forEach((v, i) => { env['EXAMPLE_' + i + '_TOKEN'] = v; });
  }
  return { home, root, env };
}

function snapshot(dirs) {
  const out = [];
  for (const d of dirs) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const st = fs.lstatSync(p);
        out.push(p + ' ' + st.size + ' ' + st.mtimeMs);
        if (e.isDirectory()) walk(p);
      }
    })(d);
  }
  return out.sort().join('\n');
}

function textOf(r) {
  let s = '';
  const code = report(r, (x) => { s += x; });
  return { s, code };
}

test('reach names secrets and credential files but never shows a value', async (t) => {
  const m = machine(t, { found: ['.cursor'] });
  const r = await reach({ root: m.root, home: m.home, env: m.env });
  const json = JSON.stringify(r);
  const { s, code } = textOf(r);
  assert.equal(code, 0);
  for (const v of FAKES) {
    assert.ok(!json.includes(v), 'value in JSON: ' + v);
    assert.ok(!s.includes(v), 'value in text: ' + v);
  }
  const env = r.findings.find((f) => f.kind === 'dotenv' && f.file === '.env');
  assert.ok(env, 'the .env finding');
  assert.equal(env.severity, 'high');
  assert.match(env.title, /has 15 secrets \(OPENAI_API_KEY, DATABASE_URL, STRIPE_SECRET, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, \.\.\.\)/);
  assert.equal(env.fix, 'npx -y zn-gate env shadow .env');
  assert.ok(r.findings.find((f) => f.kind === 'dotenv' && f.file === '.env.local'));
  assert.ok(!r.findings.find((f) => f.kind === 'dotenv' && f.file === '.env.example'), 'an example file is not a secret file');
  const creds = r.findings.find((f) => f.kind === 'credential-files');
  assert.deepEqual(creds.files.map((c) => c.path), ['~/.aws/credentials', '~/.npmrc', '~/.ssh/deploy_key', '~/.ssh/id_ed25519']);
  const names = r.findings.find((f) => f.kind === 'environment');
  assert.deepEqual(names.names, FAKES.slice(24, 30).map((_, i) => 'EXAMPLE_' + i + '_TOKEN'));
  assert.match(env.detail, /^Cursor can read them today\.$/);
  assert.ok(r.findings.find((f) => f.section === 'agents' && /^Cursor is on this machine and zn does not protect it$/.test(f.title)));
  assert.match(s, /WHAT THEY CAN REACH/);
  assert.match(s, /NEXT: fix the high ones\n {2}1\. npx -y zn-gate init\n {2}2\. npx -y zn-gate env shadow \.env/);
});

test('reach writes nothing, starts no hook and sends nothing', async (t) => {
  const m = machine(t, { agents: ['codex', 'cursor'] });
  const before = snapshot([m.home, m.root]);
  const net = ['net', 'http', 'https', 'dns', 'tls'].map((n) => require(n));
  const cp = require('child_process');
  const saved = [];
  // Every use is recorded, so a caller that catches the error cannot hide it.
  const hits = [];
  const trap = (obj, name, label) => {
    saved.push([obj, name, obj[name]]);
    obj[name] = () => { hits.push(label + name); throw new Error('reach used ' + name); };
  };
  for (const mod of net) for (const name of ['connect', 'createConnection', 'request', 'get', 'lookup', 'resolve']) if (typeof mod[name] === 'function') trap(mod, name, 'net:');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) trap(cp, name, 'process:');
  if (typeof globalThis.fetch === 'function') trap(globalThis, 'fetch', 'net:');
  // Writes anywhere, the temporary folder included (where a live check would make its test folder).
  for (const name of ['mkdtempSync', 'mkdtemp', 'writeFileSync', 'writeFile', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'symlinkSync', 'open', 'createWriteStream']) trap(fs, name, 'write:');
  for (const name of ['open', 'writeFile', 'appendFile', 'mkdtemp', 'mkdir', 'rm', 'rename', 'unlink']) trap(fs.promises, name, 'write:promises.');
  const openSync = fs.openSync;
  saved.push([fs, 'openSync', openSync]);
  fs.openSync = (p, flags, ...rest) => {
    const c = fs.constants;
    const writes = typeof flags === 'number' ? (flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_TRUNC)) !== 0
      : flags !== undefined && !/^rs?$/.test(String(flags));
    if (writes) { hits.push('write:openSync ' + flags); throw new Error('reach opened a file for writing'); }
    return openSync(p, flags, ...rest);
  };
  // check.js and the Claude Code adapter take spawnSync when they load: load them again under the trap.
  const fresh = ['../lib/check', '../lib/agents/claude-code'].map((p) => require.resolve(p));
  const reload = () => { for (const p of fresh) delete require.cache[p]; };
  reload();
  let r;
  try {
    r = await reach({ root: m.root, home: m.home, env: m.env });
  } finally {
    for (const [obj, name, fn] of saved) obj[name] = fn;
    reload();
  }
  assert.deepEqual(hits, []);
  assert.equal(snapshot([m.home, m.root]), before);
  const byId = (id) => r.agents.find((a) => a.id === id);
  assert.equal(byId('codex').state, 'protected');
  assert.equal(byId('cursor').state, 'protected');
});

test('reach with zn set up for every agent found reports the secrets as info only', async (t) => {
  const m = machine(t, { agents: ['claude-code', 'codex', 'cursor', 'opencode'] });
  const r = await reach({ root: m.root, home: m.home, env: m.env });
  assert.equal(r.findings.find((f) => f.kind === 'dotenv' && f.file === '.env').severity, 'info');
  assert.equal(r.findings.find((f) => f.kind === 'credential-files').severity, 'info');
  assert.ok(!r.findings.some((f) => f.section === 'agents'), JSON.stringify(r.findings.filter((f) => f.section === 'agents')));
});

test('without any agent on this machine, secrets are low findings and nothing is called unprotected', async (t) => {
  const m = machine(t);
  const r = await reach({ root: m.root, home: m.home, env: m.env });
  const env = r.findings.find((f) => f.kind === 'dotenv' && f.file === '.env');
  assert.equal(env.severity, 'low');
  assert.match(env.detail, /No coding agent was found here yet/);
  assert.ok(!r.findings.some((f) => f.section === 'agents'));
});

test('a clean machine has nothing to fix', async (t) => {
  const m = machine(t, { secrets: false });
  const r = await reach({ root: m.root, home: m.home, env: m.env });
  const { s } = textOf(r);
  assert.equal(r.counts.high + r.counts.medium + r.counts.low, 0, JSON.stringify(r.findings));
  assert.match(s, /No supported coding agent was found on this machine, and nothing here needs fixing/);
});

test('environment variable names: only names that end like a secret, with a value that could be one', () => {
  const names = _internal.secretEnvNames({
    GITHUB_TOKEN: 'zn-test-fake-value-x1', OPENAI_API_KEY: 'zn-test-fake-value-x2', DB_PASSWORD: 'zn-test-fake-value-x3',
    TOKEN_LIMIT: 'abcdefghijkl', AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE0', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    MAX_TOKEN: '4096', SHORT_TOKEN: 'abc', MARKED_TOKEN: '__ZN_MARKED_TOKEN__', FLAG_SECRET: 'true', HOME: '/home/example',
  });
  assert.deepEqual(names, ['DB_PASSWORD', 'GITHUB_TOKEN', 'OPENAI_API_KEY']);
});

test('MCP servers and project settings come from zn audit, in their own sections', async (t) => {
  const m = machine(t, { secrets: false });
  fs.writeFileSync(path.join(m.root, '.mcp.json'), JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'example-mcp-server'] } } }));
  const r = await reach({ root: m.root, home: m.home, env: m.env });
  const mcp = r.findings.filter((f) => f.section === 'mcp');
  assert.ok(mcp.length, JSON.stringify(r.findings));
  assert.ok(mcp.every((f) => /^ZNA00[3-6]$/.test(f.id)));
  assert.match(textOf(r).s, /MCP SERVERS \(extra tools your agent can call\)/);
});

test('values in MCP and hook command lines are hidden, and names cannot send terminal escapes', async (t) => {
  const m = machine(t, { secrets: false });
  const VALUES = ['zn-test-fake-flag-token-0001', '0123456789abcdef0123456789abcdef', 'zn-test-fake-pass-0003',
    'zn-test-fake-bearer-0004', 'zn-test-fake-header-0005', 'zn-test-fake-name-0006', 'zn-test-fake-json-0007',
    'zn-test-fake-escaped-0008', 'zn-test-fake-user-pass-0009', 'zn-test-fake-pat-0010'];
  fs.writeFileSync(path.join(m.root, '.mcp.json'), JSON.stringify({ mcpServers: {
    'evil\u001b[2J\u001b]0;pwned\u0007': { command: 'npx', args: ['-y', 'example-mcp-server', '--token=' + VALUES[0], '--api-key', VALUES[1], '--password', VALUES[2], '--from-env', '${EXAMPLE_TOKEN}'] },
  } }));
  fs.mkdirSync(path.join(m.root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(m.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command',
    command: 'curl -H "Authorization: Bearer ' + VALUES[3] + '" -H "x-api-key: ' + VALUES[4] + '" https://example.invalid/x?y=1 && EXAMPLE_API_TOKEN=' + VALUES[5] + ' true' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'curl -u deploy:' + VALUES[8] + ' -d \'{"apiKey":"' + VALUES[6] + '"}\' -d "{\\"api_token\\":\\"' + VALUES[7] + '\\"}" https://example.invalid/hook && gh --pat ' + VALUES[9] + ' status' }] }] } }));
  const r = await reach({ root: m.root, home: m.home, env: m.env });
  const json = JSON.stringify(r);
  const { s } = textOf(r);
  assert.ok(r.findings.some((f) => f.section === 'mcp'), 'the MCP server is reported');
  assert.ok(r.findings.some((f) => f.section === 'project'), 'the hook is reported');
  for (const v of VALUES) {
    assert.ok(!json.includes(v), 'value in JSON: ' + v);
    assert.ok(!s.includes(v), 'value in text: ' + v);
  }
  assert.match(s, /\$\{EXAMPLE_TOKEN\}/, 'a reference is not a value');
  assert.match(s, /deploy:\[REDACTED\]/, 'the second hook is quoted, with its value hidden');
  // Words that only look like secret names are left alone.
  const { redact } = require('../lib/audit');
  assert.equal(redact('MAX_TOKENS=4096 author: Example tokens: 5'), 'MAX_TOKENS=4096 author: Example tokens: 5');
  // More curl and JSON shapes, and long tokens: nothing of the value is left.
  const jwt = 'eyJ' + 'x'.repeat(700) + '.zn-test-fake-jwt-tail';
  for (const line of ['curl -u "deploy:zn-test-fake-q1" x', "curl -u 'deploy:zn-test-fake-q2' x", 'curl -udeploy:zn-test-fake-q3 x',
    '{"password":"ab\\"zn-test-fake-q4"}', '--token ' + jwt, 'API_TOKEN="' + jwt + '"']) {
    const out = redact(line);
    assert.doesNotMatch(out, /zn-test-fake/, line.slice(0, 60) + ' -> ' + out.slice(0, 120));
  }
  // Only the value is hidden: the next field of escaped JSON, and a URL after a flag that starts with -u, stay.
  const escaped = redact('-d "{\\"password\\":\\"zn-test-fake-r1\\",\\"user\\":\\"example-user\\"}"');
  assert.doesNotMatch(escaped, /zn-test-fake/);
  assert.match(escaped, /example-user/, escaped);
  assert.equal(redact('tool -url:https://example.invalid/path'), 'tool -url:https://example.invalid/path');
  // An escaped quote or backslash inside an escaped JSON value never ends it early.
  for (const line of ['{\\"password\\":\\"ab\\\\\\"zn-test-fake-e1\\"}', '{\\"token\\":\\"\\\\\\"zn-test-fake-e2\\"}','PASSWORD: \\"\\\\\\"zn-test-fake-e3\\"',
    '{\\"password\\":\\"ab\\\\\\"zn-test-fake-e4\\",\\"x\\":\\"y\\"}', '{\\"password\\":\\"ab\\\\\\\\zn-test-fake-e5\\"}',
    'curl -u deploy:http://zn-test-fake-e6 x', 'curl --user=deploy:git+ssh://zn-test-fake-e7 x',
    '"args": ["-y", "example-mcp", "--api-key", "zn-test-fake-e8"]', String.raw`{\"args\":[\"--token\",\"zn-test-fake-e9\"]}`,
    '"args": ["--github-token", "zn-test-fake-e10"]', '"args": ["--openai-api-key", "zn-test-fake-e11", "--client-secret", "zn-test-fake-e12"]',
    String.raw`{\"args\":[\"--github-token\",\"zn-test-fake-e13\"]}`]) {
    assert.doesNotMatch(redact(line), /zn-test-fake/, line + ' -> ' + redact(line));
  }
  // A value that ends in an escaped backslash still ends at its own closing quote.
  assert.equal(redact(String.raw`{\"password\":\"ab\\\\\",\"user\":\"keepme\"}`), String.raw`{\"password\":[REDACTED],\"user\":\"keepme\"}`);
  assert.doesNotMatch(s, /[\u001b\u0007]/);
  assert.doesNotMatch(json, /\\u001b|\\u0007/);
});

test('zn audit never shows part of a value cut at the end of a long line', async (t) => {
  const { audit } = require('../lib/audit');
  const root = tempDir(t, 'zn-reach-cut-');
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'.slice(0, 36);
  // A value that a cut at 8192 characters would split, after a run of whitespace.
  for (const pad of [8150, 8170, 8185, 8190]) {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), ' '.repeat(pad) + token + '\n');
    const json = JSON.stringify(audit({ root }).findings);
    assert.ok(!json.includes(token.slice(0, 12)), 'part of the token at pad ' + pad);
  }
});

test('an incomplete check never says that nothing needs fixing', () => {
  const { s } = textOf({ agents: [{ id: 'codex', name: 'Codex CLI', found: true, state: 'protected' }], findings: [], counts: { high: 0, medium: 0, low: 0, info: 0 }, truncated: true });
  assert.doesNotMatch(s, /Nothing to fix/);
  assert.match(s, /Some files were not checked in time/);
});

test('a .env that is a link is reported, not read', { skip: process.platform === 'win32' }, async (t) => {
  const m = machine(t, { secrets: false });
  const outside = path.join(m.home, 'elsewhere.env');
  fs.writeFileSync(outside, 'OPENAI_API_KEY=' + FAKES[0] + '\n');
  fs.symlinkSync(outside, path.join(m.root, '.env'));
  const r = await reach({ root: m.root, home: m.home, env: m.env });
  assert.ok(r.findings.find((f) => f.kind === 'dotenv-link' && f.file === '.env'));
  assert.ok(!r.findings.some((f) => f.kind === 'dotenv'));
  assert.ok(!JSON.stringify(r).includes(FAKES[0]));
});

test('--sarif: one result per finding that is not info, with no value, and --fail-on sets the exit code', (t) => {
  const m = machine(t, { found: ['.cursor'] });
  const env = { ...m.env, ZN_STATS: 'off' };
  const run = (...a) => spawnSync(process.execPath, [CLI, 'reach', m.root, ...a], { encoding: 'utf8', env, cwd: m.root });
  const s = run('--sarif');
  assert.equal(s.status, 0, s.stderr);
  const sarif = JSON.parse(s.stdout);
  assert.equal(sarif.version, '2.1.0');
  const run0 = sarif.runs[0];
  assert.equal(run0.tool.driver.name, 'zn-gate reach');
  const ids = run0.results.map((x) => x.ruleId);
  assert.ok(ids.includes('ZNR002'), ids.join(','));
  // Code scanning refuses a result without a file of the repository: every result has one.
  for (const x of run0.results) {
    assert.equal(run0.tool.driver.rules[x.ruleIndex].id, x.ruleId);
    assert.ok(['error', 'warning', 'note'].includes(x.level));
    const loc = x.locations && x.locations[0] && x.locations[0].physicalLocation.artifactLocation;
    assert.ok(loc && loc.uriBaseId === '%SRCROOT%' && !loc.uri.startsWith('~'), JSON.stringify(x));
  }
  // What belongs to the machine is reported as notifications of the run.
  const notes = run0.invocations[0].toolExecutionNotifications.map((n) => n.message.text).join('\n');
  assert.match(notes, /Cursor is on this machine/);
  assert.match(notes, /credential files in your home folder/);
  assert.match(notes, /environment variables with a secret/);
  const env0 = run0.results.find((x) => x.ruleId === 'ZNR002' && x.locations[0].physicalLocation.artifactLocation.uri === '.env');
  assert.ok(env0, 'the .env result has its file');
  for (const v of FAKES) assert.ok(!s.stdout.includes(v), 'value in SARIF: ' + v);
  // One more secret in the .env does not change the fingerprint of its result.
  const fp = (out) => JSON.parse(out).runs[0].results.find((x) => x.ruleId === 'ZNR002' && x.locations[0].physicalLocation.artifactLocation.uri === '.env').partialFingerprints['znReach/v1'];
  const before = fp(s.stdout);
  fs.appendFileSync(path.join(m.root, '.env'), 'EXTRA_TOKEN=zn-test-fake-extra-0001\n');
  assert.equal(fp(run('--sarif').stdout), before);
  assert.equal(run('--json', '--fail-on', 'high').status, 1);
  assert.equal(run('--json', '--fail-on=none').status, 0);
  assert.equal(run('--json', '--fail-on', 'bogus').status, 2);
  assert.equal(run('--json', '--sarif').status, 2);
  // Every agent protected: the secrets are info, so --fail-on low passes.
  const clean = machine(t, { agents: ['claude-code', 'codex', 'cursor', 'opencode'], secrets: false });
  const ok = spawnSync(process.execPath, [CLI, 'reach', clean.root, '--json', '--fail-on', 'low'], { encoding: 'utf8', env: { ...clean.env, ZN_STATS: 'off' }, cwd: clean.root });
  assert.equal(ok.status, 0, ok.stdout);
});

test('--remember keeps only counts, and only when asked; the next run shows them', (t) => {
  const m = machine(t, { found: ['.cursor'] });
  const env = { ...m.env, ZN_STATS: 'off' };
  const file = _internal.memoryFile(m.home, env);
  const run = (...a) => spawnSync(process.execPath, [CLI, 'reach', m.root, ...a], { encoding: 'utf8', env, cwd: m.root });
  assert.equal(run().status, 0);
  assert.ok(!fs.existsSync(file), 'nothing is written without --remember');
  const first = run('--remember');
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /last time/);
  const saved = fs.readFileSync(file, 'utf8');
  for (const v of FAKES) assert.ok(!saved.includes(v));
  assert.ok(!saved.includes(m.root) && !saved.includes('OPENAI_API_KEY') && !saved.includes('.env'), saved);
  const entry = Object.values(JSON.parse(saved))[0];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'high', 'low', 'medium']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const second = run('--remember');
  assert.match(second.stdout, /\(last time, \d{4}-\d{2}-\d{2}: \d+ high, \d+ medium, \d+ low\)/);
  // A file with entries that are not counts is tolerated, and cleaned.
  fs.writeFileSync(file, JSON.stringify({ a: null, b: {}, ['0'.repeat(32)]: [1] }));
  const third = run('--remember');
  assert.equal(third.status, 0, third.stderr);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), []);
  // Only counts and a date from the file reach the report: an edited entry cannot send terminal escapes.
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const k = Object.keys(data)[0];
  data[k] = { high: '1e309', medium: -3, low: 2, at: '\u001b[2J\u001b]0;x\u0007' };
  fs.writeFileSync(file, JSON.stringify(data));
  const fourth = run('--remember');
  assert.doesNotMatch(fourth.stdout, /[\u001b\u0007]/);
  assert.match(fourth.stdout, /\(last time, an earlier run: 0 high, 0 medium, 2 low\)/);
});

test('zn-gate reach on the command line: --json, and usage errors exit 2', (t) => {
  const m = machine(t);
  const env = { ...m.env, ZN_STATS: 'off' };
  const ok = spawnSync(process.execPath, [CLI, 'reach', m.root, '--json'], { encoding: 'utf8', env, cwd: m.root });
  assert.equal(ok.status, 0, ok.stderr);
  const r = JSON.parse(ok.stdout);
  assert.equal(r.tool, 'zn-gate reach');
  for (const v of FAKES) assert.ok(!ok.stdout.includes(v));
  const text = spawnSync(process.execPath, [CLI, 'reach'], { encoding: 'utf8', env, cwd: m.root });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /zn-gate reach: what can the coding agents on this machine reach\?/);
  assert.equal(spawnSync(process.execPath, [CLI, 'reach', '--bogus'], { encoding: 'utf8', env }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, 'reach', path.join(m.root, 'missing')], { encoding: 'utf8', env }).status, 2);
});
