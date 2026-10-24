'use strict';

// The parent-process check for commands that only a person may run: it finds the agents' command-line programs
// among the ancestors (also when the agent removed its variables) and never an editor app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { _internal } = require('../lib/broker/ancestry');
const tty = require('../lib/broker/tty');
const { tempDir } = require('./helpers/tmp');

const { agentOf, parseStat, parsePs, parseCim, walk } = _internal;

test('agentOf: the agents\' programs and their JavaScript entry points, never an editor app', () => {
  const yes = [
    [{ name: 'claude', argv: ['claude'] }, 'claude'],
    [{ name: 'claude', argv: ['/home/u/.local/bin/claude', '--resume'] }, 'claude'],
    [{ name: 'node', argv: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'] }, 'claude'],
    [{ name: 'node', argv: ['/opt/node/bin/node', '/home/u/.npm/_npx/1/node_modules/@openai/codex/bin/codex.js'] }, 'codex'],
    [{ name: 'codex.exe', argv: [String.raw`C:\Users\u\AppData\Roaming\npm\codex.exe`, 'exec'] }, 'codex'],
    [{ name: 'node.exe', argv: [String.raw`C:\Program Files\nodejs\node.exe`, String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode`] }, 'opencode'],
    [{ name: 'opencode', argv: ['opencode'] }, 'opencode'],
    [{ name: 'cursor-agent', argv: ['/home/u/.local/bin/cursor-agent'] }, 'cursor-agent'],
    [{ name: '2.1.300', argv: ['/home/u/.local/share/claude/versions/2.1.300', '--continue'] }, 'claude'],
  ];
  for (const [p, want] of yes) assert.equal(agentOf(p), want, JSON.stringify(p));
  const no = [
    { name: 'Code', argv: ['/usr/share/code/code', '--type=renderer'] },
    { name: 'Code.exe', argv: [String.raw`C:\Program Files\Microsoft VS Code\Code.exe`] },
    { name: 'Cursor', argv: ['/Applications/Cursor.app/Contents/MacOS/Cursor'] },
    { name: 'cursor', argv: ['/usr/bin/cursor'] },
    { name: 'bash', argv: ['bash', '-c', 'claude'] },
    { name: 'node', argv: ['node', '/home/u/project/claude-code-notes.js'] },
    { name: 'claude-helper', argv: ['claude-helper'] },
    { name: 'zsh', argv: ['-zsh'] },
  ];
  for (const p of no) assert.equal(agentOf(p), null, JSON.stringify(p));
});

test('parsers: /proc stat with parentheses in the name, ps and CIM tables', () => {
  assert.deepEqual(parseStat('4242 (we (ird) name) S 77 4242 4242 0 -1'), { name: 'we (ird) name', ppid: 77 });
  const ps = parsePs('    1     0 launchd /sbin/launchd\n  500     1 claude /Users/John Smith/.local/bin/claude --resume\n  600   500 zsh /bin/zsh -c zn unlock\n' +
    '  700     1 node node /Users/u/.npm/_npx/9/node_modules/@openai/codex/bin/codex.js\n  800     1 Code /Applications/Visual Studio Code.app/Contents/MacOS/Code\n');
  assert.equal(ps.get(600).ppid, 500);
  assert.equal(agentOf(ps.get(500)), 'claude'); // a space in the path: the program name still decides
  assert.equal(agentOf(ps.get(700)), 'codex');
  assert.equal(agentOf(ps.get(800)), null);
  const cim = parseCim(JSON.stringify([
    { ProcessId: 10, ParentProcessId: 4, Name: 'explorer.exe', CommandLine: String.raw`C:\Windows\explorer.exe` },
    { ProcessId: 20, ParentProcessId: 10, Name: 'node.exe', CommandLine: String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js"` },
    { ProcessId: 30, ParentProcessId: 20, Name: 'pwsh.exe', CommandLine: null },
  ]));
  assert.equal(agentOf(cim.get(20)), 'claude');
  assert.equal(cim.get(30).ppid, 20);
  assert.equal(parseCim('not json').size, 0);
  assert.equal(parseCim(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: 'codex.exe', CommandLine: 'codex.exe' })).size, 1);
});

test('walk: finds an agent several levels up, stops on loops, depth and missing parents', () => {
  const t = new Map([[30, { ppid: 20, name: 'bash' }], [20, { ppid: 10, name: 'sh' }], [10, { ppid: 1, name: 'codex', argv: ['codex'] }], [1, { ppid: 0, name: 'init' }]]);
  assert.equal(walk(30, (p) => t.get(p) || null), 'codex');
  const loop = new Map([[3, { ppid: 2, name: 'a' }], [2, { ppid: 3, name: 'b' }]]);
  assert.equal(walk(3, (p) => loop.get(p) || null), null);
  const deep = new Map(Array.from({ length: 60 }, (_, i) => [i + 2, { ppid: i + 3, name: 'sh' }]));
  deep.set(62, { ppid: 0, name: 'claude', argv: ['claude'] });
  assert.equal(walk(2, (p) => deep.get(p) || null), null); // beyond MAX_DEPTH: nothing, never a throw
  assert.equal(walk(30, () => null), null);
  // The process itself is not counted: only its parents.
  const self = new Map([[7, { ppid: 0, name: 'claude', argv: ['claude'] }]]);
  assert.equal(walk(7, (p) => self.get(p) || null), null);
});

test('walk on Windows: a parent id reused by a later claude.exe is not the parent; a real older one is', () => {
  const rows = (agentCreated) => JSON.stringify([
    { ProcessId: 50, ParentProcessId: 40, Name: 'node.exe', CommandLine: 'node.exe cli.js', Created: 2000 },
    { ProcessId: 40, ParentProcessId: 4, Name: 'claude.exe', CommandLine: 'claude.exe', Created: agentCreated },
  ]);
  const reused = parseCim(rows(3000));
  assert.equal(walk(50, (p) => reused.get(p) || null), null);
  const real = parseCim(rows(1000));
  assert.equal(walk(50, (p) => real.get(p) || null), 'claude');
});

test('requireHuman: an agent program among the parents is refused even without the agent variables', () => {
  const io = { env: { PATH: '/usr/bin' }, stdin: { isTTY: true }, ancestry: () => 'codex' };
  assert.throws(() => tty.requireHuman('zn secret set', io), (e) => e.code === 'ZN_POLICY_DENIED'
    && /zn found it was started from codex\)\. If you are not using an AI agent, open a new terminal window and try again\./.test(e.message));
  assert.doesNotThrow(() => tty.requireHuman('zn secret set', { ...io, ancestry: () => null }));
  assert.equal(tty.agentDetected({ CLAUDECODE: '' }, { ancestry: () => 'codex' }), 'CLAUDECODE');
});

test('zn unlock with the system keychain refuses without an interactive terminal', async (t) => {
  const { runVaultCommand } = require('../lib/vault/cli');
  const home = tempDir(t, 'zn-unlock-home-');
  // A child process: its stdin is a pipe, never a terminal, and ZN_HOME keeps it away from any real vault.
  const r = spawnSync(process.execPath, ['-e',
    'require(' + JSON.stringify(require.resolve('../lib/vault/cli')) + ').runVaultCommand(["unlock", "--backend", "libsecret"])' +
    '.then((c) => process.exit(c || 0), (e) => { process.stderr.write(String(e.message)); process.exit(3); })'],
  { encoding: 'utf8', input: '', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') } });
  assert.equal(typeof runVaultCommand, 'function');
  // Run from inside an agent the parent check refuses first; otherwise the terminal check does. Both refuse.
  assert.match(r.stderr + r.stdout, /unlock needs an interactive terminal|not by an AI agent/, r.stderr + r.stdout);
  assert.notEqual(r.status, 0);
});

test('agentAncestor: a real process started through a program called claude is found; one called code is not', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t, 'zn-ancestry-');
  const probe = path.join(dir, 'probe.js');
  fs.writeFileSync(probe, "const { spawnSync } = require('child_process');\n" +
    "const r = spawnSync(process.argv[2], ['-e', 'process.stdout.write(String(require(' + JSON.stringify(process.argv[3]) + ').agentAncestor()))'], { encoding: 'utf8' });\n" +
    "process.stdout.write(r.stdout || r.stderr || '');\n");
  const lib = path.join(__dirname, '..', 'lib', 'broker', 'ancestry.js');
  for (const [name, want] of [['claude', 'claude'], ['code', 'null']]) {
    const link = path.join(dir, name);
    fs.symlinkSync(process.execPath, link);
    const r = spawnSync(link, [probe, process.execPath, lib], { encoding: 'utf8' });
    assert.equal(r.stdout, want, name + ': ' + r.stdout + r.stderr);
  }
});
