#!/usr/bin/env node
// Fails when docs/examples/README.md does not list its pages in alphabetical order within each section.
// A section is the run of list entries under one heading (or before the first heading). An entry is a line
// that starts with `- [name.md](`; entries are compared by that file name, in plain character order, which
// is also the order in which the files sort in a directory listing.
//
//   node .github/scripts/check-docs-examples-index.mjs [index.md]     default: docs/examples/README.md
//
// Entries inside fenced code blocks are ignored. The check reports every entry that comes before a name that
// sorts after it, with the line numbers, and changes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* The sections of a Markdown text: [{ heading, entries: [{ name, line }] }]. `heading` is null before the first one. */
export function sections(text) {
  const out = [{ heading: null, entries: [] }];
  let fence = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (fence) return;
    const h = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (h) {
      out.push({ heading: h[1].trim(), entries: [] });
      return;
    }
    const e = line.match(/^[-*+][ \t]+\[([^\]]+)\]\(/);
    if (e) out[out.length - 1].entries.push({ name: e[1], line: i + 1 });
  });
  return out;
}

/* The entries that are listed after a name that sorts later: [{ heading, name, line, after, afterLine }]. */
export function outOfOrder(text) {
  const found = [];
  for (const s of sections(text)) {
    for (let i = 1; i < s.entries.length; i++) {
      const prev = s.entries[i - 1];
      const cur = s.entries[i];
      if (cur.name < prev.name) found.push({ heading: s.heading, name: cur.name, line: cur.line, after: prev.name, afterLine: prev.line });
    }
  }
  return found;
}

function main(argv) {
  const file = argv[0] || 'docs/examples/README.md';
  const text = fs.readFileSync(file, 'utf8');
  const bad = outOfOrder(text);
  const total = sections(text).reduce((n, s) => n + s.entries.length, 0);
  if (bad.length) {
    for (const b of bad) {
      const where = b.heading ? ` (section "${b.heading}")` : '';
      console.error(`${file}:${b.line}: "${b.name}" is listed after "${b.after}" (line ${b.afterLine})${where}; it sorts before it.`);
    }
    console.error('\nList the pages of each section in alphabetical order.');
    return 1;
  }
  console.log(`docs examples index OK: ${total} entries in ${file}, alphabetical within each section`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-examples-index: ' + e.message); process.exitCode = 1; }
}
