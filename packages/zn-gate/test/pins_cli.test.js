'use strict';
// zn-gate pins (lib/pins-cli.js): listing, the approval confirmation and its error paths.
// Every test uses its own home folder. The confirmation runs in a child process
// that pretends its stdin and stderr are a terminal, and answers come from stdin.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI_PINS = path.join(__dirname, '..', 'lib', 'pins-cli.js');
const pinsCli = require('../lib/pins-cli');
const pins = require('../lib/mcp-pins');
const messages = require('../lib/messages');

// No agent around: an empty environment and no parent process to find.
const NO_AGENT = { env: {}, ancestry: () => null };

const WEATHER = { name: 'weather', description: 'Current weather for a city.', inputSchema: { type: 'object' } };
const WEATHER_CHANGED = { ...WEATHER, description: 'Changed by the server.' };
const WEATHER_KEY = pins.serverKey('node', ['weather-srv']);
const CLOCK_KEY = pins.serverKey('node', ['clock-srv']);

function freshHome(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pins-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run fn with the home folder set to home, restoring the environment afterwards. */
async function withHome(home, fn) {
  const keys = ['HOME', 'USERPROFILE', 'ZN_HOME', 'ZN_MCP_PINNING'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ZN_HOME;
  delete process.env.ZN_MCP_PINNING;
  try {
    return await fn();
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

/** Collect what run() writes to stdout and stderr. */
async function capture(fn) {
  const out = [];
  const err = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  process.stdout.write = (x) => { out.push(String(x)); return true; };
  process.stderr.write = (x) => { err.push(String(x)); return true; };
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** Pin a server's tools (the first list is pinned, nothing is flagged). */
function pinServer(home, command, args, tools) {
  return withHome(home, () => pins.check(command, args, tools, {}));
}

/** Change a pinned server's tools so that they are pending approval. */
function changeServer(home, command, args, tools) {
  return withHome(home, () => pins.check(command, args, tools, {}));
}

function pendingOf(home, key) {
  return withHome(home, () => pins.list().find((s) => s.key === key).pending);
}

const CHILD = [
  "const io = { env: {}, ancestry: () => null };",
  "if (process.argv[3] === 'tty') {",
  "  Object.defineProperty(process.stdin, 'isTTY', { value: true });",
  "  Object.defineProperty(process.stderr, 'isTTY', { value: true });",
  '}',
  "require(process.argv[1]).run(JSON.parse(process.argv[2]), io).then((code) => { process.exitCode = code; });",
].join('\n');

/** Run the pins command in a child process with a fake terminal or a plain pipe. */
function runPins(home, args, { tty = false, input = '' } = {}) {
  const r = spawnSync(process.execPath, ['-e', CHILD, CLI_PINS, JSON.stringify(args), tty ? 'tty' : 'pipe'], {
    encoding: 'utf8',
    input,
    timeout: 20000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_STATS: 'off' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('list with no pins says so and exits 0', async (t) => {
  const home = freshHome(t);
  const r = await withHome(home, () => capture(() => pinsCli.run(['list'], NO_AGENT)));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^No MCP server has been pinned yet\./);
});

test('no arguments lists the same way as "list"', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  const bare = await withHome(home, () => capture(() => pinsCli.run([], NO_AGENT)));
  const named = await withHome(home, () => capture(() => pinsCli.run(['list'], NO_AGENT)));
  assert.strictEqual(bare.code, 0);
  assert.strictEqual(bare.stdout, named.stdout);
});

test('list shows each pinned server, its tool count and the pending changes', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await pinServer(home, 'node', ['clock-srv'], [{ name: 'time', description: 'Clock.' }]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const r = await withHome(home, () => capture(() => pinsCli.run(['list'], NO_AGENT)));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^MCP tool pins \(.*mode: warn\)/);
  assert.ok(r.stdout.includes('  ' + WEATHER_KEY + '  '), 'weather key is printed in full');
  assert.ok(r.stdout.includes('  ' + CLOCK_KEY + '  '), 'clock key is printed in full');
  assert.match(r.stdout, /1 tool\(s\) pinned/);
  assert.match(r.stdout, /changed or new since then: weather/);
  assert.match(r.stdout, /Review what changed, then accept it with: zn-gate pins approve <server>/);
  // The clock server has no pending change, so it gets no "changed or new" line of its own.
  assert.strictEqual((r.stdout.match(/changed or new since then/g) || []).length, 1);
});

test('list without pending changes prints no approval hint', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  const r = await withHome(home, () => capture(() => pinsCli.run([], NO_AGENT)));
  assert.doesNotMatch(r.stdout, /changed or new/);
  assert.doesNotMatch(r.stdout, /accept it with/);
});

test('list shows at most 20 pending names and then an ellipsis', async (t) => {
  const home = freshHome(t);
  const names = (n) => Array.from({ length: n }, (_, i) => ({ name: 'tool-' + String(i).padStart(2, '0'), description: 'd' }));
  await pinServer(home, 'node', ['weather-srv'], names(25));
  await changeServer(home, 'node', ['weather-srv'], names(25).map((x) => ({ ...x, description: 'new' })));
  const r = await withHome(home, () => capture(() => pinsCli.run(['list'], NO_AGENT)));
  assert.match(r.stdout, /tool-19, \.\.\./);
  assert.ok(!r.stdout.includes('tool-20'), 'the 21st pending name is not printed');
});

test('a pins file that cannot be read is listed as unreadable and approve skips it', async (t) => {
  const home = freshHome(t);
  await withHome(home, () => fs.mkdirSync(pins.pinsDir(), { recursive: true }));
  const bad = path.join(home, '.zn', 'mcp-pins', CLOCK_KEY + '.json');
  fs.writeFileSync(bad, '{not json');
  const listed = await withHome(home, () => capture(() => pinsCli.run(['list'], NO_AGENT)));
  assert.match(listed.stdout, /\(unreadable pins file\)/);
  const r = runPins(home, ['approve', '--all'], { tty: true, input: 'all\n' });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Nothing to approve\./);
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{not json', 'the unreadable file is left as it is');
});

test('an unknown subcommand prints the usage and exits 2', async (t) => {
  const home = freshHome(t);
  const r = await withHome(home, () => capture(() => pinsCli.run(['frobnicate'], NO_AGENT)));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /^usage: zn-gate pins \[list\] \| zn-gate pins approve <server>\|--all/);
});

test('approve without a server prints its usage and exits 2', async (t) => {
  const home = freshHome(t);
  const r = await withHome(home, () => capture(() => pinsCli.run(['approve'], NO_AGENT)));
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.stderr.trim(), messages.PINS_USAGE_APPROVE);
});

test('approve from an agent is refused before anything is asked, and changes nothing', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const agentByVar = await withHome(home, () => capture(() => pinsCli.run(['approve', WEATHER_KEY], { env: { CLAUDECODE: '1' }, ancestry: () => null })));
  assert.strictEqual(agentByVar.code, 2);
  assert.strictEqual(agentByVar.stderr.trim(), messages.pinsAgentRefusal('CLAUDECODE'));
  const agentByParent = await withHome(home, () => capture(() => pinsCli.run(['approve', '--all'], { env: {}, ancestry: () => 'codex' })));
  assert.strictEqual(agentByParent.code, 2);
  assert.strictEqual(agentByParent.stderr.trim(), messages.pinsAgentRefusal('started from codex'));
  assert.deepStrictEqual(await pendingOf(home, WEATHER_KEY), ['weather']);
});

test('approve without a terminal is refused, even when the answer is piped in', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const r = runPins(home, ['approve', WEATHER_KEY], { input: WEATHER_KEY + '\n' });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.stderr.trim(), messages.PINS_NEEDS_TERMINAL);
  assert.deepStrictEqual(await pendingOf(home, WEATHER_KEY), ['weather']);
});

test('approve in a terminal asks for the key again and accepts it with surrounding spaces', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const r = runPins(home, ['approve', WEATHER_KEY], { tty: true, input: '  ' + WEATHER_KEY + '  \n' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /Type the server key again to approve: /);
  assert.strictEqual(r.stdout.trim(), 'Approved weather of node weather-srv');
  assert.deepStrictEqual(await pendingOf(home, WEATHER_KEY), []);
});

test('a wrong answer in a terminal approves nothing and exits 2', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const r = runPins(home, ['approve', WEATHER_KEY], { tty: true, input: 'y\n' });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.stderr.trim().split('\n').pop(), messages.PINS_NOT_APPROVED);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(await pendingOf(home, WEATHER_KEY), ['weather']);
});

test('an empty answer or a closed input approves nothing', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const empty = runPins(home, ['approve', WEATHER_KEY], { tty: true, input: '\n' });
  assert.strictEqual(empty.code, 2);
  assert.match(empty.stderr, new RegExp(messages.PINS_NOT_APPROVED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const closed = runPins(home, ['approve', WEATHER_KEY], { tty: true, input: '' });
  assert.strictEqual(closed.code, 2, 'end of input is a refusal, not a silent exit');
  assert.match(closed.stderr, new RegExp(messages.PINS_NOT_APPROVED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepStrictEqual(await pendingOf(home, WEATHER_KEY), ['weather']);
});

test('approve --all needs the word "all"; typing a server key is refused', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const byKey = runPins(home, ['approve', '--all'], { tty: true, input: WEATHER_KEY + '\n' });
  assert.strictEqual(byKey.code, 2);
  assert.match(byKey.stderr, /Type "all" again to approve: /);
  const byWord = runPins(home, ['approve', '--all'], { tty: true, input: 'all\n' });
  assert.strictEqual(byWord.code, 0, byWord.stderr);
  assert.deepStrictEqual(await pendingOf(home, WEATHER_KEY), []);
});

test('approve --all accepts the pending changes of every server', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await pinServer(home, 'node', ['clock-srv'], [{ name: 'time', description: 'Clock.' }]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  await changeServer(home, 'node', ['clock-srv'], [{ name: 'time', description: 'Clock, new.' }, { name: 'extra', description: 'New tool.' }]);
  const r = runPins(home, ['approve', '--all'], { tty: true, input: 'all\n' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Approved weather of node weather-srv/);
  assert.match(r.stdout, /Approved time, extra of node clock-srv/);
  assert.deepStrictEqual(await pendingOf(home, CLOCK_KEY), []);
});

test('approve for a key with nothing pending says so and exits 0', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  const r = runPins(home, ['approve', WEATHER_KEY], { tty: true, input: WEATHER_KEY + '\n' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'Nothing to approve.');
});

test('approve for an unknown key is an error after the confirmation, and changes nothing', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const unknown = '0123456789abcdef';
  const r = runPins(home, ['approve', unknown], { tty: true, input: unknown + '\n' });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.stderr.trim().split('\n').pop(), messages.pinsError('no server ' + unknown));
  assert.deepStrictEqual(await pendingOf(home, WEATHER_KEY), ['weather']);
});

test('a key that is not a pin file name cannot reach another file', async (t) => {
  const home = freshHome(t);
  await pinServer(home, 'node', ['weather-srv'], [WEATHER]);
  await changeServer(home, 'node', ['weather-srv'], [WEATHER_CHANGED]);
  const traversal = '../' + WEATHER_KEY;
  const r = runPins(home, ['approve', traversal], { tty: true, input: traversal + '\n' });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /zn-gate pins: no server/);
  assert.deepStrictEqual(await pendingOf(home, WEATHER_KEY), ['weather']);
});
