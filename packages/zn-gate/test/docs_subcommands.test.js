'use strict';
// Every zn-gate subcommand written as a command in docs/*.md must exist in the CLI help.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { helpFor } = require('../lib/vault/help');

const repo = path.resolve(__dirname, '..', '..', '..');
const docsDir = path.join(repo, 'docs');
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const present = fs.existsSync(docsDir) && fs.existsSync(CLI);

// Commands in inline code (`zn-gate check`) or at the start of a code line ($ npx -y zn-gate check).
const INLINE = /`(?:npx -y |npx )?zn-gate ([a-z][a-z-]*)/g;
const LINE = /^\s*(?:\$ )?(?:npx -y |npx )?zn-gate ([a-z][a-z-]*)/gm;

function docFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...docFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function documentedSubcommands() {
  const found = new Map();
  for (const file of docFiles(docsDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const inCode = [];
    // Only shell blocks hold commands; text blocks show sample output.
    text.replace(/```(?:bash|sh|shell|console)\n([\s\S]*?)```/g, (_, body) => { inCode.push(body); return ''; });
    const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
    const hits = [];
    for (const m of prose.matchAll(INLINE)) hits.push(m[1]);
    for (const body of inCode) for (const m of body.matchAll(LINE)) hits.push(m[1]);
    for (const name of hits) {
      if (!found.has(name)) found.set(name, path.relative(repo, file));
    }
  }
  return found;
}

test('every zn-gate subcommand named in docs/*.md exists in the CLI help', { skip: !present }, () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  const listed = new Set();
  for (const line of help.stdout.split('\n')) {
    const m = /^ {2}([a-z][a-z-]*(?:, -?[A-Za-z-]+)*)\s{2,}/.exec(line);
    if (m) for (const n of m[1].split(', ')) listed.add(n);
  }
  const found = documentedSubcommands();
  assert.ok(found.size > 10, 'the docs name several subcommands');
  const missing = [];
  for (const [name, file] of found) {
    // Commands with their own help (unlock, lock) are not in the main list.
    if (!listed.has(name) && !helpFor([name, '--help'])) missing.push(`${name} (${file})`);
  }
  assert.deepEqual(missing, []);
});
