#!/usr/bin/env node
// Fails when a docs page (docs/**/*.md) or the root README.md contains a literal TODO or FIXME marker.
// The marker is the upper-case word on its own: TODO and FIXME in any position of a line, including code
// blocks, count. Lower-case prose such as "todo list" does not.
//
//   node .github/scripts/check-docs-todo.mjs [path ...]     default: docs README.md
//
// A directory is scanned for *.md files (sorted, so the output is stable); a file is checked as it is.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = /\b(TODO|FIXME)\b/g;

/* The markers of a Markdown text: [{ line, word, text }], one entry per marker occurrence. */
export function findMarkers(text) {
  const hits = [];
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(MARKER)) hits.push({ line: i + 1, word: m[1], text: line.trim() });
  });
  return hits;
}

function listMarkdown(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return p.endsWith('.md') ? [p] : [];
  const out = [];
  for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const c = path.join(p, e.name);
    if (e.isDirectory()) out.push(...listMarkdown(c));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(c);
  }
  return out;
}

/* Returns { checked, hits: [{ file, line, word, text }] } for the given paths (files or directories). */
export function checkPaths(paths) {
  const files = paths.flatMap((p) => listMarkdown(p));
  const hits = [];
  for (const f of files) {
    for (const h of findMarkers(fs.readFileSync(f, 'utf8'))) {
      hits.push({ file: f.split(path.sep).join('/'), ...h });
    }
  }
  return { checked: files.length, hits };
}

function main(argv) {
  const paths = argv.length ? argv : ['docs', 'README.md'];
  const { checked, hits } = checkPaths(paths);
  if (hits.length) {
    for (const h of hits) console.error(`${h.file}:${h.line}: ${h.word}: ${h.text}`);
    console.error(`\n${hits.length} TODO/FIXME marker(s). Finish the text or move the open item to the board.`);
    return 1;
  }
  console.log(`docs markers OK: ${checked} file(s) checked, no TODO or FIXME`);
  return 0;
}

// realpath: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-todo: ' + e.message); process.exitCode = 1; }
}
