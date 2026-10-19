'use strict';
// docs/cli.md documents every command of bin/cli.js, and only those.
//
// The list of commands is read from the program itself, two ways:
//   1. the dispatch code (the `command === '...'` branches of bin/cli.js, its
//      BROKER_COMMANDS set, and the sub-command branches of the modules it hands over to);
//   2. the commands printed by `zn-gate --help`.
// A command found by either must have a heading in docs/cli.md, and every heading or
// alias line in docs/cli.md must be a real command. So a new command or alias fails this
// test until it is documented, and a documented command that no longer exists fails it too.
//
// Format of docs/cli.md:  ### `secret set`   (a heading made of one backticked command path)
//                         Aliases: `secret ls`, `secret list2`   (a line of full command paths)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const cliSrc = read(path.join(pkgRoot, 'bin', 'cli.js'));
const docs = read(path.join(repoRoot, 'docs', 'cli.md'));

function matches(re, text) {
  const out = [];
  let m;
  const g = new RegExp(re.source, 'g');
  while ((m = g.exec(text))) out.push(m[1]);
  return out;
}

// The body of `function name(` ... up to the next top-level `function` or end of file.
function functionBody(src, name) {
  const start = src.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, 'function ' + name + ' not found');
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:async )?function |\nmodule\.exports/);
  return rest.slice(0, next === -1 ? undefined : next);
}

// ---- 1. commands from the dispatch code ----------------------------------------------

function commandsFromCode() {
  const set = new Set();
  const add = (c) => set.add(c);

  // bin/cli.js: top-level words.
  for (const w of matches(/(?:\bcommand|\bargs\[0\]) === '([a-z][a-z-]*)'/, cliSrc)) add(w);
  const broker = /BROKER_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(cliSrc);
  assert.ok(broker, 'BROKER_COMMANDS not found in bin/cli.js');
  for (const w of matches(/'([a-z][a-z-]*)'/, broker[1])) add(w);
  if (/args\[0\] === 'version'/.test(cliSrc)) add('version');

  // secret / env groups (lib/broker/cli.js, function dispatch).
  const brokerSrc = read(path.join(pkgRoot, 'lib', 'broker', 'cli.js'));
  const body = functionBody(brokerSrc, 'dispatch');
  let group = null;
  for (const line of body.split('\n')) {
    const g = /if \(group === '([a-z]+)'/.exec(line);
    if (g) group = g[1] === 'secrets' ? 'secret' : g[1];
    for (const s of matches(/\bsub === '([a-z]+)'/, line)) if (group) add(group + ' ' + s);
  }
  // zn hooks install|uninstall.
  const hooksFn = functionBody(brokerSrc, 'hooks');
  const acts = /\[((?:'[a-z]+',?\s*)+)\]\.includes\(action\)/.exec(hooksFn);
  assert.ok(acts, 'hooks actions not found');
  for (const a of matches(/'([a-z]+)'/, acts[1])) add('hooks ' + a);

  // vault (lib/vault/cli.js, runVaultCommand).
  const vaultFn = functionBody(read(path.join(pkgRoot, 'lib', 'vault', 'cli.js')), 'runVaultCommand');
  for (const s of matches(/cmd === 'vault' && sub === '([a-z]+)'/, vaultFn)) add('vault ' + s);

  // team (lib/team/cli.js, runTeamCommand).
  const teamFn = functionBody(read(path.join(pkgRoot, 'lib', 'team', 'cli.js')), 'runTeamCommand');
  for (const s of matches(/sub === '([a-z]+)'/, teamFn)) add('team ' + s);

  // pins (lib/pins-cli.js) and stats share (lib/stats-cli.js).
  const pinsFn = functionBody(read(path.join(pkgRoot, 'lib', 'pins-cli.js')), 'run');
  for (const s of matches(/\bsub === '([a-z]+)'/, pinsFn)) if (s !== 'list') add('pins ' + s);
  const statsFn = functionBody(read(path.join(pkgRoot, 'lib', 'stats-cli.js')), 'run');
  if (/o\.rest\[0\] === 'share'/.test(statsFn)) add('stats share');
  for (const s of matches(/\bsub === '([a-z]+)'/, statsFn)) add('stats share ' + s);

  return set;
}

// ---- 2. commands from --help ----------------------------------------------------------

function commandsFromHelp() {
  const r = spawnSync(process.execPath, [path.join(pkgRoot, 'bin', 'cli.js'), '--help'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { NO_COLOR: '1', ZN_STATS: 'off' }),
  });
  assert.strictEqual(r.status, 0, 'zn-gate --help should exit 0');
  const set = new Set();
  let inScope = false;
  for (const line of r.stdout.split('\n')) {
    const header = /^([A-Z][A-Z -]+?)(?: \(.*\))?:$/.exec(line);
    if (header) { inScope = /^(COMMANDS|SECRETS|VAULT|TEAM)$/.test(header[1]); continue; }
    if (!inScope) continue;
    const m = /^ {2}(\S.*?)(?: {2,}|$)/.exec(line);
    if (!m) continue;
    for (const spec of m[1].split(', ')) {
      const words = [];
      for (const w of spec.split(/\s+/)) {
        if (/^[<\[-]/.test(w) || /^[A-Z_]+$/.test(w)) break;
        words.push(w);
      }
      if (words.length) set.add(words.join(' '));
    }
  }
  return set;
}

// ---- 3. what docs/cli.md documents ----------------------------------------------------

function documented() {
  const headings = new Set();
  const aliases = new Set();
  for (const line of docs.split('\n')) {
    const h = /^#{2,4} `([a-z][a-z0-9 -]*)`\s*$/.exec(line);
    if (h) headings.add(h[1]);
    const a = /^Aliases?: (.+?)\.?\s*$/.exec(line);
    if (a) for (const p of matches(/`([a-z][a-z0-9 -]*)`/, a[1])) aliases.add(p);
  }
  return { headings, aliases, all: new Set([...headings, ...aliases]) };
}

const fmt = (s) => [...s].sort().join(', ');

test('docs/cli.md documents every command found in the dispatch code', () => {
  const doc = documented();
  const missing = [...commandsFromCode()].filter((c) => !doc.all.has(c));
  assert.deepStrictEqual(missing, [], 'commands in bin/cli.js (and its modules) with no entry in docs/cli.md: ' + fmt(missing));
});

test('docs/cli.md documents every command printed by --help', () => {
  const doc = documented();
  const missing = [...commandsFromHelp()].filter((c) => !doc.all.has(c));
  assert.deepStrictEqual(missing, [], 'commands in `zn-gate --help` with no entry in docs/cli.md: ' + fmt(missing));
});

test('docs/cli.md documents no command that the program does not have', () => {
  const doc = documented();
  const real = new Set([...commandsFromCode(), ...commandsFromHelp()]);
  // Group words are real commands even when only their sub-commands are matched above.
  const extra = [...doc.all].filter((c) => !real.has(c));
  assert.deepStrictEqual(extra, [], 'entries in docs/cli.md that are not commands of bin/cli.js: ' + fmt(extra));
});

test('every program name in package.json is named in docs/cli.md', () => {
  const pkg = JSON.parse(read(path.join(pkgRoot, 'package.json')));
  for (const name of Object.keys(pkg.bin)) {
    assert.ok(docs.includes('`' + name + '`'), 'docs/cli.md does not mention the program name `' + name + '`');
  }
});

test('the command finders see the commands that must exist (guard against a finder going blind)', () => {
  const code = commandsFromCode();
  const help = commandsFromHelp();
  for (const c of ['init', 'scan', 'audit', 'secret set', 'env shadow', 'vault verify', 'team join', 'hooks install', 'run']) {
    assert.ok(code.has(c), 'dispatch finder lost: ' + c);
  }
  for (const c of ['init', 'scan', 'secret set', 'vault verify', 'team join', 'hooks install', 'run']) {
    assert.ok(help.has(c), 'help finder lost: ' + c);
  }
});
