'use strict';
// `zn-gate <command> --help` and `-h` print the help of that command, not the general help,
// and exit 0 with the text on stdout. A command listed in the general help or in docs/cli.md
// without a help page of its own fails here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HELP, ALIASES, helpFor } = require('../lib/cli-help');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const DOC = path.join(__dirname, '..', '..', '..', 'docs', 'cli.md');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-subhelp-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function run(words) {
  return spawnSync(process.execPath, [CLI, ...words], {
    encoding: 'utf8',
    input: '',
    timeout: 20000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true' },
  });
}

const general = run(['--help']).stdout;

// Commands that have their own page elsewhere (vault, team, audit, reach, uninstall) or whose
// subcommands print a short line that lists them (secret set ...): not part of this module.
const OWN_HELP_ELSEWHERE = new Set(['audit', 'reach', 'team', 'uninstall', 'unlock', 'lock', 'vault']);
const SUBCOMMANDS_OF_SECRET = new Set(['set', 'list', 'allow', 'approve', 'rm', 'import', 'adopt', 'get']);
// First word of every command in the COMMANDS, SECRETS, VAULT and TEAM sections of the general help.
function commandsOfGeneralHelp() {
  const names = new Set();
  let section = '';
  for (const line of general.split(String.fromCharCode(10))) {
    const h = /^([A-Z][A-Z -]*)[ (:]/.exec(line);
    if (h) section = h[1].trim();
    if (!/^(COMMANDS|SECRETS|VAULT|TEAM)$/.test(section)) continue;
    const m = /^ {2}([a-z][a-z-]*(?:, -?[A-Za-z-]+)*)(?: |$)/.exec(line);
    if (!m) continue;
    for (const n of m[1].split(', ')) if (/^[a-z]/.test(n) && n !== 'zn-gate') names.add(n);
  }
  return names;
}

function documentedWords() {
  const out = [];
  for (const line of fs.readFileSync(DOC, 'utf8').split(/\r?\n/)) {
    const m = /^#{3,4} `([a-z][a-z -]*)`\s*$/.exec(line);
    if (m) out.push(m[1].trim().split(/\s+/));
  }
  return out;
}

test('the general help lists commands to check', () => {
  const names = commandsOfGeneralHelp();
  for (const known of ['init', 'scan', 'status', 'evidence', 'stats']) assert.ok(names.has(known), known);
});

test('every command of the general help has a help of its own', () => {
  for (const name of commandsOfGeneralHelp()) {
    if (OWN_HELP_ELSEWHERE.has(name)) continue;
    const r = run([name, '--help']);
    assert.strictEqual(r.status, 0, name + ': exit code; stderr: ' + r.stderr);
    assert.strictEqual(r.stderr, '', name);
    assert.ok(r.stdout.trim().length > 0, name + ': empty');
    assert.notStrictEqual(r.stdout, general, name + ' prints the general help');
    assert.match(r.stdout, /^usage: zn(-gate)? /, name + ': first line is a usage line');
  }
});

test('every documented command has a help of its own', () => {
  for (const words of documentedWords()) {
    if (OWN_HELP_ELSEWHERE.has(words[0])) continue;
    // `secret set --help` and the like print one short line that lists the secret subcommands.
    if (words[0] === 'secret' && SUBCOMMANDS_OF_SECRET.has(words[1])) continue;
    const label = words.join(' ');
    const r = run([...words, '--help']);
    assert.strictEqual(r.status, 0, label + ': exit code; stderr: ' + r.stderr);
    assert.notStrictEqual(r.stdout, general, label + ' prints the general help');
  }
});

test('-h prints exactly what --help prints, for every command and alias', () => {
  const names = [...Object.keys(HELP).map((k) => k.split(' ')), ...Object.keys(ALIASES).map((k) => [k])];
  for (const words of names) {
    const a = run([...words, '--help']);
    const b = run([...words, '-h']);
    assert.strictEqual(a.status, 0, words.join(' '));
    assert.strictEqual(b.status, 0, words.join(' '));
    assert.strictEqual(b.stdout, a.stdout, words.join(' '));
    assert.strictEqual(b.stderr, '', words.join(' '));
  }
});

test('every help starts with a usage line for its own command and has an example', () => {
  for (const [key, lines] of Object.entries(HELP)) {
    assert.ok(lines[0].startsWith('usage: zn-gate ' + key), key + ': ' + lines[0]);
    assert.ok(lines.some((l) => l.startsWith('Example: ')), key + ': no example');
  }
  for (const [alias, target] of Object.entries(ALIASES)) assert.ok(HELP[target], alias + ' -> ' + target);
});

test('a --help that belongs to the wrapped program is left alone', () => {
  assert.strictEqual(helpFor(['run', '--', 'node', '--help']), null);
  assert.strictEqual(helpFor(['shield', '--', 'uvx', 'tool', '--help']), null);
  assert.strictEqual(helpFor(['analyze', 'text', '--help']), null);
  assert.strictEqual(helpFor(['secret', 'log', '--help']), null);
});

test('stats share and pins approve have their own pages', () => {
  assert.match(run(['stats', 'share', '--help']).stdout, /^usage: zn-gate stats share/);
  assert.match(run(['stats', 'share', 'on', '-h']).stdout, /^usage: zn-gate stats share/);
  assert.match(run(['pins', 'approve', '--help']).stdout, /^usage: zn-gate pins approve/);
});
