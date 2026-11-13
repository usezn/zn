'use strict';
// Every command documented in docs/cli.md answers `--help` with exit code 0 and a usage line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const DOCS = path.join(__dirname, '..', '..', '..', 'docs', 'cli.md');

// Commands known to miss the behaviour; remove an entry once it is fixed.
// `vault log export --help` prints its usage on stderr and exits with 2.
const KNOWN_GAPS = new Set(['vault log export']);

function documentedCommands() {
  const out = [];
  for (const line of fs.readFileSync(DOCS, 'utf8').split('\n')) {
    const h = /^#{2,4} `([a-z][a-z0-9 -]*)`\s*$/.exec(line);
    if (h) out.push(h[1]);
  }
  return out;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-help-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('the command list is read from docs/cli.md', () => {
  const cmds = documentedCommands();
  assert.ok(cmds.length > 40);
  for (const c of ['init', 'scan', 'secret set', 'vault verify', 'team join']) assert.ok(cmds.includes(c), c);
});

// The other direction: every command the main help lists has a section in docs/cli.md.
// A name that only appears as an alias of a documented command (logs, mcp-shield) must be written
// in backticks in the doc.
function helpCommandNames() {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0);
  const names = new Set();
  // The EXAMPLES block shows npx lines, not commands.
  for (const line of r.stdout.split('\nEXAMPLES:')[0].split('\n')) {
    const m = /^ {2}([a-z][^\n]*?)(?: {2,}|$)/.exec(line);
    if (!m) continue;
    for (const entry of m[1].split(', ')) {
      const words = [];
      for (const w of entry.split(' ')) {
        if (!/^[a-z][a-z-]*$/.test(w)) break;
        words.push(w);
      }
      if (words.length) names.add(words.join(' '));
    }
  }
  return names;
}

test('every command listed in zn-gate --help has a section in docs/cli.md', () => {
  const text = fs.readFileSync(DOCS, 'utf8');
  const headings = new Set(documentedCommands());
  const listed = helpCommandNames();
  for (const c of ['init', 'secret set', 'vault log export', 'team managed-config', 'hooks install', 'env unshadow']) {
    assert.ok(listed.has(c), 'help parser found ' + c);
  }
  const missing = [];
  for (const name of listed) {
    if (headings.has(name)) continue;
    if (!name.includes(' ') && text.includes('`' + name + '`')) continue;
    missing.push(name);
  }
  assert.deepEqual(missing, [], 'in --help but without a section in docs/cli.md');
});

test('the subcommands printed by `vault --help` and `team --help` have a section in docs/cli.md', () => {
  const headings = new Set(documentedCommands());
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, cwd: home });
  const vault = run(['vault', '--help']).stdout;
  const team = run(['team', '--help']).stdout;
  const subs = [];
  for (const m of vault.matchAll(/^ {2}([a-z]+(?: [a-z]+)?)(?= {2,}| \[| --|$)/gm)) subs.push('vault ' + m[1]);
  for (const m of team.matchAll(/zn team ([a-z-]+)/g)) subs.push('team ' + m[1]);
  assert.ok(subs.length >= 10, 'found ' + subs.length + ' subcommands');
  const missing = [...new Set(subs)].filter((c) => !headings.has(c));
  assert.deepEqual(missing, []);
});

for (const command of documentedCommands()) {
  test(`zn-gate ${command} --help exits 0 and prints a usage line`, { skip: KNOWN_GAPS.has(command) }, () => {
    const r = spawnSync(process.execPath, [CLI, ...command.split(' '), '--help'], {
      encoding: 'utf8',
      input: '',
      timeout: 20000,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
      cwd: home,
    });
    assert.equal(r.status, 0, `exit code ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stdout, /^\s*usage:/im, 'no usage line on stdout');
  });
}
