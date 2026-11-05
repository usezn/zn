'use strict';
// Every command line in a bash code block under docs/ that starts with `zn` or `zn-gate` must
// use a command that `bin/cli.js --help` lists. A renamed or removed command, or a typo in an
// example, fails here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const docsDir = path.join(pkgRoot, '..', '..', 'docs');
const cli = path.join(pkgRoot, 'bin', 'cli.js');

// Command words used in the docs that the help output does not list (none today).
const NOT_IN_HELP = new Set([]);

function helpCommands(text) {
  // Entries of the help: two spaces, a lowercase name, optionally more names after commas
  // ("version, -V"), then the description or arguments.
  const out = new Set();
  for (const line of text.split('\n')) {
    const m = /^ {2}([a-z][a-z-]*(?:, [A-Za-z-]+)*)(?= |$)/.exec(line);
    if (!m) continue;
    for (const n of m[1].split(', ')) if (/^[a-z]/.test(n)) out.add(n);
  }
  return out;
}

function docCommands(md) {
  // [{ program, word }] for command lines inside bash/sh code blocks.
  const found = [];
  let inBash = false;
  let inOther = false;
  for (const raw of md.split('\n')) {
    const fence = /^\s*```\s*([A-Za-z0-9_-]*)/.exec(raw);
    if (fence) {
      if (inBash || inOther) inBash = inOther = false;
      else if (/^(bash|sh|shell)$/.test(fence[1])) inBash = true;
      else inOther = true;
      continue;
    }
    if (!inBash) continue;
    const m = /^\s*(?:\$ )?(zn-gate|zn)\s+([^\s]+)/.exec(raw);
    if (m && /^[a-z]/.test(m[2])) found.push({ program: m[1], word: m[2] });
  }
  return found;
}

function markdownFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

test('the parsers read help entries and bash blocks only', () => {
  const cmds = helpCommands('  init   Set up\n  version, -V   Show\n  secret set NAME  Store\n    deeper line\n');
  assert.deepStrictEqual([...cmds].sort(), ['init', 'secret', 'version']);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-docs-'));
  try {
    const file = path.join(tmp, 'a.md');
    fs.writeFileSync(file, [
      '```bash', '$ zn-gate stats --json', 'zn audit .', 'echo zn nothing', '```',
      '```text', 'zn-gate bogus', '```',
      'zn-gate prose outside',
    ].join('\n'));
    const found = docCommands(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(found, [
      { program: 'zn-gate', word: 'stats' },
      { program: 'zn', word: 'audit' },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('docs command lines use commands listed in the help output', { skip: !fs.existsSync(docsDir) }, () => {
  const r = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  const known = helpCommands(r.stdout);
  assert.ok(known.has('init') && known.has('stats') && known.has('vault'), 'help parsed');
  let checked = 0;
  const bad = [];
  for (const file of markdownFiles(docsDir)) {
    for (const { program, word } of docCommands(fs.readFileSync(file, 'utf8'))) {
      checked++;
      if (!known.has(word) && !NOT_IN_HELP.has(word)) bad.push(path.relative(docsDir, file) + ': ' + program + ' ' + word);
    }
  }
  assert.ok(checked > 20, 'found command lines in the docs');
  assert.deepStrictEqual(bad, []);
});
