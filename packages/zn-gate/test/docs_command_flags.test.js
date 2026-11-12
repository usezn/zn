'use strict';
// Every `zn` / `zn-gate` / `npx -y zn-gate[@ver]` command line in a shell code block of docs/**/*.md,
// README.md and packages/*/README.md must use a subcommand and options that the current CLI has.
// Nothing is hand-listed: the commands come from `bin/cli.js --help` and the help of the vault commands,
// the options from that help text and from the option literals in bin/ and lib/.
// Limit: an option is checked against all options of the CLI, not against the one command it follows.
// Blocks marked text/output/json/etc. and placeholders such as <agent> are skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pkgRoot = path.resolve(__dirname, '..');
const repo = path.resolve(pkgRoot, '..', '..');
const cli = path.join(pkgRoot, 'bin', 'cli.js');
const present = fs.existsSync(path.join(repo, 'docs')) && fs.existsSync(cli);

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps1', 'pwsh', 'cmd']);

function walk(dir, pred, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

function docFiles() {
  const files = walk(path.join(repo, 'docs'), (p) => p.endsWith('.md'));
  const readme = path.join(repo, 'README.md');
  if (fs.existsSync(readme)) files.push(readme);
  const pk = path.join(repo, 'packages');
  if (fs.existsSync(pk)) {
    for (const e of fs.readdirSync(pk, { withFileTypes: true })) {
      const r = path.join(pk, e.name, 'README.md');
      if (e.isDirectory() && fs.existsSync(r)) files.push(r);
    }
  }
  return files;
}

// Splits a command line into words; quoted strings become one word marked with a leading quote.
function words(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[3] !== undefined ? m[3] : '"' + (m[1] !== undefined ? m[1] : m[2]));
  return out;
}

// [{ line, program, args }] for the zn commands in the shell blocks of one markdown text (line is 1-based).
function docCommands(md) {
  const found = [];
  const lines = md.split('\n');
  let lang = null; // null = outside a block
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```\s*([A-Za-z0-9_+-]*)/.exec(lines[i]);
    if (fence) { lang = lang === null ? fence[1].toLowerCase() : null; continue; }
    if (lang === null) continue;
    const shell = SHELL_LANGS.has(lang);
    if (!shell && !(lang === '' && /^\s*\$ /.test(lines[i]))) continue;
    if (lang === 'console' && !/^\s*\$ /.test(lines[i])) continue; // console blocks mix commands and output
    const start = i;
    let text = lines[i];
    while (/\\\s*$/.test(text) && i + 1 < lines.length && !/^\s*```/.test(lines[i + 1])) {
      text = text.replace(/\\\s*$/, ' ') + lines[++i];
    }
    text = text.replace(/^\s*\$ /, '').trim();
    if (text.startsWith('#')) continue;
    for (const seg of text.split(/\s*(?:\|\||&&|\||;)\s*/)) {
      const w = words(seg.replace(/\s#\s.*$/, ''));
      let k = 0;
      while (k < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k])) k++;
      if (w[k] === 'sudo') k++;
      if (w[k] === 'npx') { k++; while (w[k] === '-y' || w[k] === '--yes') k++; }
      const prog = w[k];
      if (!prog || !/^(zn|zn-gate)(@[\w.-]+)?$/.test(prog)) continue;
      found.push({ line: start + 1, program: prog.replace(/@.*/, ''), args: w.slice(k + 1) });
    }
  }
  return found;
}

// Command phrases of the help ("secret set", "init", "version") and their first words.
function helpPhrases(text) {
  const phrases = new Set();
  for (const line of text.split('\n')) {
    const m = /^ {2}([a-z][a-z-]*(?:, -?[A-Za-z-]+)*)((?: [a-z][a-z-]*)*)(?= |$)/.exec(line);
    if (!m) continue;
    for (const n of m[1].split(', ')) if (/^[a-z]/.test(n)) phrases.add(n);
    const first = m[1].split(', ')[0];
    const rest = m[2].trim().split(' ').filter(Boolean);
    if (rest.length && /^(secret|vault|env|hooks|team|check|init|reach|audit)$/.test(first)) phrases.add(first + ' ' + rest[0]);
  }
  return phrases;
}

function optionsOf(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) out.add(m[1]);
  return out;
}

function shortOptionsOf(text) {
  const out = new Set(['-h', '-V']);
  for (const m of text.matchAll(/(?<![\w-])(-[A-Za-z])(?![\w-])/g)) out.add(m[1]);
  return out;
}

// Problems of one command: [] when the subcommand and every option are known.
function problems(cmd, known) {
  const out = [];
  const a = cmd.args.filter((x) => !x.startsWith('"'));
  const cutAt = a.indexOf('--');
  const upto = cutAt === -1 ? a : a.slice(0, cutAt);
  const plain = upto.filter((x) => !x.startsWith('-'));
  const first = plain[0];
  if (first && /^[a-z][a-z-]*$/.test(first) && upto[0] === first) {
    if (!known.phrases.has(first)) out.push('unknown command "' + first + '"');
    else if (plain[1] && /^[a-z][a-z-]*$/.test(plain[1]) && upto[1] === plain[1]) {
      const subs = [...known.phrases].filter((p) => p.startsWith(first + ' '));
      if (subs.length && !known.phrases.has(first + ' ' + plain[1]) && !known.helpFor([first, plain[1], '--help']) && !(known.src && known.src.includes("'" + plain[1] + "'"))) {
        out.push('unknown subcommand "' + first + ' ' + plain[1] + '"');
      }
    }
  }
  for (const raw of upto) {
    if (!raw.startsWith('-') || raw === '-') continue;
    const tok = raw.replace(/^\[|\]$/g, '').split('=')[0].split('|')[0];
    if (/[<>{}*.]/.test(tok) || tok === '--') continue; // placeholders and ellipses
    if (tok.startsWith('--')) {
      if (!known.long.has(tok)) out.push('unknown option "' + tok + '"');
    } else if (!known.short.has(tok)) {
      out.push('unknown option "' + tok + '"');
    }
  }
  return out;
}

function cliKnowledge() {
  const r = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const { helpFor, HELP } = require('../lib/vault/help');
  const src = walk(path.join(pkgRoot, 'bin'), (p) => p.endsWith('.js'))
    .concat(walk(path.join(pkgRoot, 'lib'), (p) => p.endsWith('.js')))
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');
  const helpText = r.stdout + '\n' + JSON.stringify(HELP || {});
  const phrases = helpPhrases(r.stdout);
  for (const name of Object.keys(HELP || {})) phrases.add(name.split(' ')[0]);
  for (const name of Object.keys(HELP || {})) if (name.includes(' ')) phrases.add(name);
  return {
    phrases,
    helpFor,
    src,
    long: new Set([...optionsOf(helpText), ...optionsOf(src)]),
    short: new Set([...shortOptionsOf(r.stdout), ...shortOptionsOf(src.replace(/[^\n]*(?:\/\/|\*)[^\n]*/g, ''))]),
  };
}

test('the parser finds zn commands in shell blocks and skips output and placeholders', () => {
  const md = [
    '```bash', '$ npx -y zn-gate@1.2.3 scan ./x --format json \\', '    --code', 'echo hi | zn why', '# zn nope', '```',
    '```text', 'zn-gate bogus --nope', '```',
    '```console', '$ zn stats --json', 'zn-gate output line', '```',
    '```', 'zn plain', '```',
  ].join('\n');
  const found = docCommands(md);
  assert.deepEqual(found.map((f) => [f.line, f.program, f.args.join(' ')]), [
    [2, 'zn-gate', 'scan ./x --format json --code'],
    [4, 'zn', 'why'],
    [11, 'zn', 'stats --json'],
  ]);
  const known = { phrases: new Set(['scan', 'stats']), long: new Set(['--format', '--code']), short: new Set(['-s']), helpFor: () => null };
  assert.deepEqual(problems({ args: ['scan', '--format', 'json', '--code'] }, known), []);
  assert.deepEqual(problems({ args: ['scan', '--nope'] }, known), ['unknown option "--nope"']);
  assert.deepEqual(problems({ args: ['bogus'] }, known), ['unknown command "bogus"']);
  assert.deepEqual(problems({ args: ['hooks', 'install', '<agent>', '--project'] }, { ...known, phrases: new Set(['hooks', 'hooks install']), long: new Set(['--project']) }), []);
  assert.deepEqual(problems({ args: ['run', '--', 'ls', '--whatever'] }, { ...known, phrases: new Set(['run']) }), []);
});

test('docs command lines use subcommands and options that the CLI has', { skip: !present }, () => {
  const known = cliKnowledge();
  assert.ok(known.phrases.has('init') && known.long.has('--format'), 'CLI knowledge parsed');
  let checked = 0;
  const bad = [];
  for (const file of docFiles()) {
    for (const cmd of docCommands(fs.readFileSync(file, 'utf8'))) {
      checked++;
      for (const p of problems(cmd, known)) bad.push(path.relative(repo, file) + ':' + cmd.line + ': ' + cmd.program + ' ' + cmd.args.join(' ') + ' -> ' + p);
    }
  }
  assert.ok(checked > 50, 'found command lines in the docs');
  assert.deepEqual(bad, []);
});
