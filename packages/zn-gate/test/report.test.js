'use strict';
// zn-gate report: reads local stats and pins only; writes nothing and opens no network connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-report-test-'));
process.env.ZN_HOME = home;
delete process.env.ZN_STATS;

// Guard: any network use during a report is a failure.
let netCalls = 0;
for (const m of ['net', 'tls', 'http', 'https', 'dns']) {
  const mod = require(m);
  for (const fn of ['connect', 'createConnection', 'request', 'get', 'lookup', 'resolve']) {
    if (typeof mod[fn] === 'function') mod[fn] = () => { netCalls++; throw new Error('network used by report'); };
  }
}
if (typeof globalThis.fetch === 'function') globalThis.fetch = () => { netCalls++; throw new Error('network used by report'); };

const stats = require('../lib/stats');
const report = require('../lib/report');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const reset = () => { for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true }); };
const NOW = new Date('2026-10-17T12:00:00Z');
const run = (args) => { let out = ''; const code = report.run(args, (s) => { out += s; }, { now: NOW }); return { code, out }; };
const snapshot = () => JSON.stringify(fs.readdirSync(home, { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(home, f)).isFile() ? fs.readFileSync(path.join(home, f), 'utf8') : '']));

function seed() {
  const at = (d) => new Date(`${d}T10:00:00Z`);
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 20, blocked: 9, redacted: 20, detections: { AWS_KEY: 14, GITHUB_TOKEN: 6 } }, { now: at('2026-10-14') });
  stats.record({ layer: 'hook', agent: 'cursor', checked: 5, blocked: 3, redacted: 11, detections: { DB_PASSWORD: 8 } }, { now: at('2026-10-15') });
  stats.record({ layer: 'hook', agent: 'claude-code', checked: 4, blocked: 40, redacted: 1 }, { now: at('2026-09-01') });
  const dir = path.join(home, 'mcp-pins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0123456789abcdef.json'), JSON.stringify({
    command: 'node /home/maria/projects/secret-client/my-mcp.js --token ' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789',
    pinnedAt: '2026-10-16T08:00:00.000Z', firstPinnedAt: '2026-10-16T08:00:00.000Z', tools: { a: 'h1' }, pending: { b: { hash: 'h2', seenAt: '2026-10-16T09:00:00Z' } },
  }));
  fs.writeFileSync(path.join(dir, 'fedcba9876543210.json'), JSON.stringify({ command: 'npx old-server', pinnedAt: '2026-10-16T00:00:00.000Z', firstPinnedAt: '2026-08-01T00:00:00.000Z', tools: {}, pending: {} }));
  // Written before firstPinnedAt existed: when it was first seen is unknown, so it is not reported as new.
  fs.writeFileSync(path.join(dir, 'bbbbbbbbbbbbbbbb.json'), JSON.stringify({ command: 'npx legacy', pinnedAt: '2026-10-16T00:00:00.000Z', tools: {}, pending: {} }));
  fs.writeFileSync(path.join(dir, 'aaaaaaaaaaaaaaaa.json'), '{not json');
}

test('empty data gives a friendly message and the Team line', () => {
  reset();
  const { code, out } = run([]);
  assert.equal(code, 0);
  assert.match(out, /Nothing to report yet/);
  assert.match(out, /usezn\.com\/team/);
});

test('a normal week: counts, agents, secret types, new servers, pending, busiest day', () => {
  reset(); seed();
  const { code, out } = run([]);
  assert.equal(code, 0);
  assert.match(out, /2026-10-11 to 2026-10-17/);
  assert.match(out, /Blocked actions\s+: 12\s+\(claude-code 9, cursor 3\)/);
  assert.match(out, /Secrets hidden\s+: 31\s+\(AWS_KEY 14, DB_PASSWORD 8, GITHUB_TOKEN 6, OTHER 3\)/);
  assert.match(out, /New MCP servers\s+: 1\s+\(node my-mcp\.js\)/);
  assert.match(out, /waiting for your approval: 1/);
  assert.match(out, /Busiest day: 2026-10-14 \(9 blocked\)/);
  assert.match(out, /Nothing left it/);
  assert.match(out, /Teams can see this for everyone in one place: usezn\.com\/team  \(hide this line: zn-gate report --no-team-line\)/);
});

test('never prints paths, folders or token values', () => {
  reset(); seed();
  const { out } = run([]);
  assert.doesNotMatch(out, /maria|projects|secret-client|ghp_|\/home/);
  assert.doesNotMatch(run(['--json']).out, /maria|projects|ghp_|--token/);
});

test('a server is named by program and package or script only, never by its arguments', () => {
  const cases = {
    'node /home/u/proj/my-mcp.js': 'node my-mcp.js',
    'npx server --token=ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234': 'npx server',
    'npx -y @scope/pkg@1.2.3 --api-key sk-fakefakefakefakefakefakefake': 'npx @scope/pkg@1.2.3',
    'npx server --token tok_fake_value_123456': 'npx server',
    'env API_TOKEN=fakevalue123456789 node s.js': 'node s.js',
    'MY_SECRET=hunter2-fake node s.js': 'node s.js',
    'mcp-remote https://user:fakepass123@mcp.example.com/sse': 'mcp-remote',
    'mcp-remote --header Authorization:Bearer_fakebearer1234567890': 'mcp-remote',
    'uvx srv --api-key sk-fakefakefakefakefakefakefakefake': 'uvx srv',
    'srv --password=Pa55wordFake': 'srv',
    'srv https://mcp.example.com/sse?api_key=fakekey123456': 'srv',
    'srv postgres://admin:fakepw@db.example.com:5432/app': 'srv',
    'C:\\Users\\alice\\proj\\srv.exe --config C:\\Users\\alice\\cfg.json': 'srv',
    'docker run -e GITHUB_TOKEN=ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234 img': 'docker',
    'node C:\\Users\\alice\\proj\\srv.js': 'node srv.js',
    'npx --token tok_fake_value_123 pkg': 'npx pkg',
    'npx --token tok_fake_value_123': 'npx',
    'npx -y --registry https://example.com/npm --auth fakeauth_123456 @scope/pkg': 'npx @scope/pkg',
    'npx -p tok_fake_value_123': 'npx',
    'uvx --index-url https://user:fakepass123@example.com/simple --with-token tok_fake_value_123 srv': 'uvx srv',
    'uvx --token tok_fake_value_123': 'uvx',
    'uvx --quiet srv --token tok_fake_value_123': 'uvx srv',
    'pnpm --config.token tok_fake_value_123 dlx pkg': 'pnpm pkg',
    'pnpm dlx --token tok_fake_value_123': 'pnpm',
    'yarn dlx --token tok_fake_value_123 pkg': 'yarn pkg',
    'bunx --token tok_fake_value_123 pkg': 'bunx pkg',
    'docker run -e TOKEN_FAKE_VALUE_123 --env-file x.env img': 'docker',
    'docker run --token tok_fake_value_123 img': 'docker',
    'node --require tok_fake_value_123 srv.js': 'node srv.js',
    '': 'MCP server',
    'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234=x': 'MCP server',
  };
  for (const [cmd, want] of Object.entries(cases)) assert.equal(report.safeName(cmd), want, cmd);
});

test('a server is new from its first pin: approving keeps firstPinnedAt, old pins are not new', () => {
  reset();
  const pinsMod = require('../lib/mcp-pins');
  const tools = [{ name: 'read', description: 'a', inputSchema: {} }];
  assert.equal(pinsMod.check('node', ['srv-one.js'], tools).first, true);
  const key = pinsMod.list()[0].key;
  const file = path.join(pinsMod.pinsDir(), key + '.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(stored.firstPinnedAt);
  // A changed tool is pending; approving it resets pinnedAt but not firstPinnedAt.
  stored.firstPinnedAt = '2026-05-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(stored));
  pinsMod.check('node', ['srv-one.js'], [{ name: 'read', description: 'changed', inputSchema: {} }]);
  pinsMod.approve(key);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.firstPinnedAt, '2026-05-01T00:00:00.000Z');
  assert.notEqual(after.pinnedAt, after.firstPinnedAt);
  assert.doesNotMatch(run(['--since', '90d']).out, /srv-one/);
});

test('hostile files: a pipe, null or garbage entries and huge numbers never hang or crash the report', (t) => {
  reset();
  if (process.platform !== 'win32') {
    const cp = require('child_process');
    cp.execFileSync('mkfifo', [path.join(home, 'stats.json')]);
    fs.mkdirSync(path.join(home, 'mcp-pins'));
    cp.execFileSync('mkfifo', [path.join(home, 'mcp-pins', '00000000000000aa.json')]);
    assert.equal(run([]).code, 0);
    assert.match(run([]).out, /Nothing to report yet/);
    reset();
  }
  fs.writeFileSync(path.join(home, 'stats.json'), JSON.stringify({ days: {
    '2026-10-16': 5,
    '2026-10-15': null,
    '2026-10-14': { 'hook:x': null, 'hook:y': 7, 'weird:z': { blocked: 5 }, 'hook:a': { blocked: 'abc', redacted: -5, checked: 1e308, detections: { '/home/alice/.env': 2, MY_COMPANY_KEY: 3, AWS_KEY: 'x' } } },
    '2026-10-13': { 'hook:b': { blocked: 1e30, redacted: 1e30, detections: null } },
    '2026-10-12': { 'hook:c': { blocked: 2, detections: { AWS_KEY: 4 } } },
  } }));
  const r = run([]);
  assert.equal(r.code, 0);
  const j = JSON.parse(run(['--json']).out);
  assert.ok(j.blocked <= 1e9 + 2 && Number.isInteger(j.blocked));
  assert.ok(j.redacted >= 0 && Number.isInteger(j.redacted));
  assert.equal(j.secret_types['/home/alice/.env'], undefined);
  assert.equal(j.secret_types.OTHER >= 5, true);
  assert.doesNotMatch(r.out, /alice|NaN|Infinity/);
  fs.writeFileSync(path.join(home, 'stats.json'), 'x'.repeat(5 * 1024 * 1024));
  assert.match(run([]).out, /Nothing to report yet/);
});

test('Secrets hidden is always the sum of its breakdown', () => {
  reset(); seed();
  const j = JSON.parse(run(['--json']).out);
  assert.equal(j.redacted, Object.values(j.secret_types).reduce((a, b) => a + b, 0));
});

test('ZN_STATS=off with data still says counting is off', () => {
  reset(); seed();
  process.env.ZN_STATS = 'off';
  try { assert.match(run([]).out, /Counting is off on this computer \(ZN_STATS=off\)/); } finally { delete process.env.ZN_STATS; }
});

test('--since changes the window; bad values exit 2', () => {
  reset(); seed();
  assert.match(run(['--since', '1d']).out, /2026-10-17 to 2026-10-17/);
  assert.match(run(['--since=90d']).out, /Blocked actions\s+: 52/);
  assert.match(run(['--since', '4d']).out, /Blocked actions\s+: 12/);
  assert.match(run(['--since', '3d']).out, /Blocked actions\s+: 3/);
  assert.match(run(['--since', '2d']).out, /Blocked actions\s+: 0/);
  for (const bad of [['--since', '91d'], ['--since', '0d'], ['--since', '7'], ['--since', '7w'], ['--since'], ['--bogus']]) {
    const r = run(bad);
    assert.equal(r.code, 2, bad.join(' '));
    assert.match(r.out, /Usage: zn-gate report/);
  }
});

test('--json has the documented schema and no Team line', () => {
  reset(); seed();
  const { code, out } = run(['--json']);
  assert.equal(code, 0);
  const j = JSON.parse(out);
  assert.deepEqual(Object.keys(j).sort(), ['blocked', 'busiest_day', 'by_agent', 'days', 'new_mcp_servers', 'pending_tool_changes', 'redacted', 'secret_types', 'sent', 'since', 'sources', 'until']);
  assert.equal(j.blocked, 12); assert.equal(j.redacted, 31); assert.equal(j.days, 7); assert.equal(j.sent, false);
  assert.deepEqual(j.by_agent, { 'claude-code': 9, cursor: 3 });
  assert.equal(j.pending_tool_changes, 1);
  assert.equal(j.new_mcp_servers.length, 1);
  assert.deepEqual(j.busiest_day, { day: '2026-10-14', blocked: 9 });
  assert.doesNotMatch(out, /Teams can see|usezn\.com\/team/);
});

test('--no-team-line and being in a Team hide the Team line', () => {
  reset(); seed();
  assert.doesNotMatch(run(['--no-team-line']).out, /usezn\.com\/team/);
  const policy = require('../lib/team/policy');
  const orig = policy.readTeam;
  policy.readTeam = () => ({ v: 1, org: 'acme' });
  try { assert.doesNotMatch(run([]).out, /usezn\.com\/team/); } finally { policy.readTeam = orig; }
});

test('ZN_STATS=off with no data says counting is off', () => {
  reset();
  process.env.ZN_STATS = 'off';
  try { assert.match(run([]).out, /Counting is off on this computer \(ZN_STATS=off\)/); } finally { delete process.env.ZN_STATS; }
});

test('corrupt stats and pins files do not break it', () => {
  reset();
  fs.writeFileSync(path.join(home, 'stats.json'), 'not json');
  fs.mkdirSync(path.join(home, 'mcp-pins'));
  fs.writeFileSync(path.join(home, 'mcp-pins', '0123456789abcdef.json'), '[]');
  assert.equal(run([]).code, 0);
});

test('writes no files and opens no network connection', () => {
  reset(); seed();
  const before = snapshot();
  run([]); run(['--json']); run(['--since', '30d']);
  assert.equal(snapshot(), before);
  assert.equal(netCalls, 0);
});

test('the report module does not load a network client', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'report.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"](https?|net|tls|\.\/client|\.\/team\/(api|cli|upload))/);
});

test('zn-gate report runs from the command line', () => {
  reset(); seed();
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.js'), 'report', '--no-team-line'], { env: { ...process.env, ZN_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /zn-gate report: /);
});
