#!/usr/bin/env node
// Fails when a Markdown page under docs/ opens a fenced code block and never closes it. An open fence makes
// every line after it code, so the rest of the page is hidden from readers and from the other checks.
//
//   node .github/scripts/check-docs-fences.mjs [docs-dir]     default: docs
//
// A fence follows CommonMark for the cases the docs use: three or more backticks or tildes, at most three
// spaces of indentation, a closing fence with the same character and at least as many characters, and no
// backtick in the info string of a backtick fence (so ```inline``` on one line is not a fence). A fence
// nested deeper than three spaces (inside a list item) is not tracked; the other checks cover those pages.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/* The 1-based line of a fence that a Markdown text opens and never closes, or null. */
export function unclosedFenceLine(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const c = line.match(CLOSE);
      if (c && c[1][0] === fence.marker && c[1].length >= fence.length) fence = null;
      continue;
    }
    const o = line.match(OPEN);
    if (!o) continue;
    if (o[1][0] === '`' && o[2].includes('`')) continue;
    fence = { marker: o[1][0], length: o[1].length, line: i + 1 };
  }
  return fence ? fence.line : null;
}

function listMarkdown(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMarkdown(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/* Returns { checked, problems: [{ file, line }] } for the Markdown files under dir. */
export function checkDir(dir) {
  const files = listMarkdown(dir);
  const problems = [];
  for (const f of files) {
    const line = unclosedFenceLine(fs.readFileSync(f, 'utf8'));
    if (line) problems.push({ file: f.split(path.sep).join('/'), line });
  }
  return { checked: files.length, problems };
}

function main(argv) {
  const dir = argv[0] || 'docs';
  const { checked, problems } = checkDir(dir);
  if (problems.length) {
    for (const p of problems) console.error(`${p.file}:${p.line}: this code fence is never closed`);
    console.error('\nAdd a closing fence (the same ``` or ~~~ as the opening one) after the last line of the block.');
    return 1;
  }
  console.log(`docs code fences OK: ${checked} page(s) under ${dir}, every fence is closed`);
  return 0;
}

// realpath: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-fences: ' + e.message); process.exitCode = 1; }
}
