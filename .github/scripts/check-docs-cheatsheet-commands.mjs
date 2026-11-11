#!/usr/bin/env node
// Fails when a command named in the "Command" column of a table of docs/commands-cheatsheet.md has no entry in
// docs/cli.md. A named command is the code text of a cell (`init`) or a link whose text is code ([`init`](cli.md#init)).
// An entry is a code-formatted heading of cli.md (### `secret set`) or an item of its contents list (- [`init`](#init)).
// Words are compared with single spaces between them. Code blocks are skipped.
//
//   node .github/scripts/check-docs-cheatsheet-commands.mjs [cheatsheet.md] [cli.md]
//
// Defaults: docs/commands-cheatsheet.md and docs/cli.md. A cheat sheet with no named command fails: an empty
// result would pass without checking anything.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const norm = (s) => s.trim().split(/\s+/).join(' ');

/* The cells of a table row; an escaped pipe (\|) stays inside its cell. */
function cells(line) {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

/* The command a cell names: the text of a code span, or of a link whose text is a code span; else null. */
export function cellCommand(cell) {
  const link = cell.match(/^\[`([^`]+)`\]\([^)]*\)$/);
  if (link) return norm(link[1]);
  const code = cell.match(/^`([^`]+)`$/);
  return code ? norm(code[1]) : null;
}

/* The commands named in the column headed "Command" of each table: [{ name, line }] (line is 1-based). */
export function namedCommands(text) {
  const out = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  let col = -1;
  let inTable = false;
  lines.forEach((line, i) => {
    if (!/^\s*\|/.test(line)) { inTable = false; col = -1; return; }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return; // the separator row under a header
    if (!inTable) {
      inTable = true;
      col = cells(line).map((c) => c.toLowerCase()).indexOf('command');
      return;
    }
    if (col < 0) return;
    const name = cellCommand(cells(line)[col] ?? '');
    if (name) out.push({ name, line: i + 1 });
  });
  return out;
}

/* The commands documented by cli.md: code-formatted headings and the items of its contents list. */
export function documentedCommands(cliText) {
  const out = new Set();
  let fence = false;
  for (const line of String(cliText).split(/\r?\n/)) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^#{1,6}\s+`([^`]+)`\s*$/);
    if (h) out.add(norm(h[1]));
    const item = line.match(/^\s*-\s+\[`([^`]+)`\]\(#[^)]*\)\s*$/);
    if (item) out.add(norm(item[1]));
  }
  return out;
}

/* Returns { checked, missing: [{ name, line }] }; throws when the cheat sheet names no command. */
export function checkCommands(cheatText, cliText) {
  const named = namedCommands(cheatText);
  if (named.length === 0) throw new Error('no command found in a "Command" column of the cheat sheet');
  const documented = documentedCommands(cliText);
  const missing = named.filter((c) => !documented.has(c.name));
  return { checked: named.length, missing };
}

function main(argv) {
  const cheatPath = argv[0] || 'docs/commands-cheatsheet.md';
  const cliPath = argv[1] || 'docs/cli.md';
  const { checked, missing } = checkCommands(fs.readFileSync(cheatPath, 'utf8'), fs.readFileSync(cliPath, 'utf8'));
  if (missing.length) {
    for (const m of missing) console.error(`${cheatPath}:${m.line}: "${m.name}" is not documented in ${cliPath}`);
    console.error(`\n${missing.length} command(s) missing from ${cliPath}: add a heading for each, or remove it from the cheat sheet.`);
    return 1;
  }
  console.log(`cheat sheet commands OK: ${checked} command(s) in ${cheatPath}, all documented in ${cliPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-cheatsheet-commands: ' + e.message); process.exitCode = 1; }
}
