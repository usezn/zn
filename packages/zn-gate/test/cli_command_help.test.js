'use strict';
// Every user-facing command has its own short help, `zn-gate help <command>` prints the same text as
// `zn-gate <command> --help`, and `zn-gate` with nothing is a five line start.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { OPTION_SPECS } = require('../lib/cli-options');
const cliHelp = require('../lib/cli-help');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const DOCS = path.join(__dirname, '..', '..', '..', 'docs', 'cli.md');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-help-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: home,
    timeout: 30000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true', NO_COLOR: '1', CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
  });
}

// The registry: every command the reference page documents as a command of its own (a "### `name`" heading),
// and every name or alias the general help lists first on a line.
function registry() {
  const names = new Set();
  for (const line of fs.readFileSync(DOCS, 'utf8').split(/\r?\n/)) {
    const m = /^### `([a-z][a-z-]*)`$/.exec(line);
    if (m) names.add(m[1]);
  }
  const general = run(['--help']).stdout;
  let inCommands = false;
  for (const line of general.split('\n')) {
    if (/^[A-Z][A-Z -]*( \(|:)/.test(line)) inCommands = /^(COMMANDS|SECRETS|VAULT|TEAM)\b/.test(line);
    const m = inCommands && /^  ([a-z][a-z-]*)(?:, ([a-z][a-z-]*))?(?: |$)/.exec(line);
    if (m) { names.add(m[1]); if (m[2]) names.add(m[2]); }
  }
  return [...names].sort();
}

const ALIASES = ['doctor', 'logs', 'export', 'mcp-shield', 'wrap', 'secrets'];

test('the registry is found and holds the commands users know', () => {
  const names = registry();
  for (const c of ['init', 'check', 'scan', 'audit', 'reach', 'connect', 'hooks', 'evidence', 'shield', 'report', 'stats', 'vault', 'unlock', 'secret', 'team']) {
    assert.ok(names.includes(c), 'registry misses ' + c);
  }
});

test('every user-facing command has its own help, and help <command> is the same text', () => {
  const general = run(['--help']);
  assert.strictEqual(general.status, 0);
  for (const name of [...registry(), ...ALIASES]) {
    const own = run([name, '--help']);
    assert.strictEqual(own.status, 0, name + ' --help exits 0');
    assert.ok(/^usage: zn /.test(own.stdout), name + ' --help starts with a usage line, got: ' + own.stdout.slice(0, 80));
    assert.notStrictEqual(own.stdout, general.stdout, name + ' --help is not the general help');
    assert.ok(own.stdout.split('\n').length < 60, name + ' --help is short');
    const viaHelp = run(['help', name]);
    assert.strictEqual(viaHelp.status, 0, 'help ' + name + ' exits 0');
    assert.strictEqual(viaHelp.stdout, own.stdout, 'help ' + name + ' is ' + name + ' --help');
  }
});

test('the short help of each command has an example and exit codes', () => {
  for (const name of Object.keys(cliHelp.COMMANDS)) {
    const text = cliHelp.helpFor(name).join('\n');
    assert.ok(/\nExample:\n {2}zn /.test(text), name + ' has an example');
    assert.ok(/\nExit codes:\n {2}\d/.test(text), name + ' has exit codes');
  }
});

test('the options listed are the ones the command checks (one source)', () => {
  for (const [cmd, spec] of Object.entries(OPTION_SPECS)) {
    const text = cliHelp.helpFor(cmd).join('\n');
    for (const opt of [...(spec.flags || []), ...(spec.values || [])]) {
      assert.ok(text.includes('  ' + opt), cmd + ' help lists ' + opt);
    }
  }
  // Every option the help describes for a command that checks its options is one that command accepts.
  for (const [cmd, c] of Object.entries(cliHelp.COMMANDS)) {
    const spec = OPTION_SPECS[cmd];
    if (!spec) continue;
    const known = [...(spec.flags || []), ...(spec.values || [])];
    for (const opt of Object.keys(c.opts)) assert.ok(known.includes(opt), cmd + ' help describes ' + opt + ' which the command does not accept');
  }
});

test('an option without a description fails the help loudly', () => {
  const saved = OPTION_SPECS.init.flags.slice();
  OPTION_SPECS.init.flags.push('--brand-new');
  try {
    assert.throws(() => cliHelp.helpFor('init'), /no description for --brand-new/);
  } finally {
    OPTION_SPECS.init.flags.length = 0;
    OPTION_SPECS.init.flags.push(...saved);
  }
});

test('zn-gate help is the general help; an unknown command is refused', () => {
  const general = run(['--help']);
  const viaHelp = run(['help']);
  assert.strictEqual(viaHelp.status, 0);
  assert.strictEqual(viaHelp.stdout, general.stdout);
  assert.ok(general.stdout.includes('COMMANDS:'));
  const bad = run(['help', 'nope']);
  assert.strictEqual(bad.status, 1);
  assert.ok(/Unknown command: nope/.test(bad.stderr));
});

test('zn-gate with no arguments prints a five line start', () => {
  const r = run([]);
  assert.strictEqual(r.status, 0);
  const lines = r.stdout.trimEnd().split('\n');
  assert.strictEqual(lines.length, 5);
  const text = r.stdout;
  for (const word of ['zn-gate init', 'zn-gate check', 'zn-gate reach', '--help']) assert.ok(text.includes(word), 'start mentions ' + word);
});

// Help must not swallow arguments that belong to someone else, and must find the right text.
test('run -- echo --help: the words after -- belong to the command, not to zn', () => {
  const r = run(['run', '--', 'echo', '--help']);
  const text = r.stdout + r.stderr;
  assert.ok(!/usage: zn(-gate)? run/.test(text), 'not the help of zn run: ' + text.slice(0, 120));
  assert.ok(!/COMMANDS:/.test(text), 'not the general help');
});

test('shield -- node x --help: the words after -- belong to the wrapped program', () => {
  const r = spawnSync(process.execPath, [CLI, 'shield', '--', 'node', 'x', '--help'], {
    encoding: 'utf8', cwd: home, input: '', timeout: 30000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true', NO_COLOR: '1' },
  });
  const text = r.stdout + r.stderr;
  assert.ok(!/usage: zn(-gate)? shield/.test(text), 'not the help of zn shield: ' + text.slice(0, 120));
  assert.ok(!/COMMANDS:/.test(text), 'not the general help');
});

test('secret set --help prints the secret help and stores nothing', () => {
  const r = run(['secret', 'set', '--help']);
  assert.strictEqual(r.status, 0);
  assert.ok(/^usage: zn secret set\|list\|rm\|allow\|approve\|import\|adopt\|log/.test(r.stdout), r.stdout.slice(0, 100));
  assert.ok(/hidden prompt/.test(r.stdout));
  assert.ok(!/COMMANDS:/.test(r.stdout));
  assert.ok(!fs.existsSync(path.join(home, '.zn', 'vault')), 'no vault was created');
});

test('hooks install codex --help prints the hooks help and changes nothing', () => {
  const r = run(['hooks', 'install', 'codex', '--help']);
  assert.strictEqual(r.status, 0);
  assert.ok(/^usage: zn hooks install\|uninstall /.test(r.stdout), r.stdout.slice(0, 100));
  assert.ok(!/COMMANDS:/.test(r.stdout));
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'hooks.json')), 'no hooks were installed');
});

test('hooks --help and help hooks list install, uninstall and the agents', () => {
  const a = run(['hooks', '--help']);
  const b = run(['help', 'hooks']);
  assert.strictEqual(a.status, 0);
  assert.strictEqual(a.stdout, b.stdout);
  for (const word of ['install', 'uninstall', 'claude-code', 'codex', 'cursor', 'opencode', 'antigravity']) assert.ok(a.stdout.includes(word), 'hooks help names ' + word);
});

test('the help of run describes -s, --agent and the exit codes the command really returns', () => {
  const text = cliHelp.helpFor('run').join('\n');
  assert.ok(/^ {2}-s A,B/m.test(text));
  assert.ok(/^ {2}--agent ID/m.test(text));
  for (const line of ['0 the exit code of your command is passed on', '1 another error', '64 ', '77 ', '127 ']) assert.ok(text.includes('  ' + line), 'run help has: ' + line);
});
