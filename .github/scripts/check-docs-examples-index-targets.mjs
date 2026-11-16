#!/usr/bin/env node
// Fails when an entry of docs/examples/README.md points to a page that does not exist in that folder.
// An entry is a list line that starts with `- [name](target)`. Its target must be a file inside the same
// folder as the index (anchors, web addresses and paths that leave the folder do not count as pages).
// Every missing target is listed with its line. An index with no entries fails too, so a list that lost
// its links cannot pass. Entries inside fenced code blocks are ignored. The check changes nothing.
//
//   node .github/scripts/check-docs-examples-index-targets.mjs [index.md]     default: docs/examples/README.md
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ENTRY_RE = /^[-*+][ \t]+\[([^\]]+)\]\(\s*<?([^)\s>]+)>?/;

/* The entries of a Markdown text outside fenced code: [{ name, target, line }]. */
export function entries(text) {
  const out = [];
  let fence = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (fence) return;
    const e = line.match(ENTRY_RE);
    if (e) out.push({ name: e[1], target: e[2], line: i + 1 });
  });
  return out;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* The entries whose target is not a file inside dir: [{ name, target, line }]. */
export function missingTargets(text, dir) {
  const root = path.resolve(dir);
  return entries(text).filter((e) => {
    const file = e.target.split('#')[0].split('?')[0];
    let decoded = file;
    try { decoded = decodeURIComponent(file); } catch { /* keep as written */ }
    if (!decoded) return true;
    const abs = path.resolve(root, decoded);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
    return !isFile(abs);
  });
}

function main(argv) {
  const file = argv[0] || path.join('docs', 'examples', 'README.md');
  const dir = path.dirname(file);
  const text = fs.readFileSync(file, 'utf8');
  const all = entries(text);
  if (!all.length) {
    console.error(`${file}: no entries found. Each page must be listed as a "- [name.md](name.md)" line.`);
    return 1;
  }
  const bad = missingTargets(text, dir);
  if (bad.length) {
    for (const b of bad) console.error(`${file}:${b.line}: entry "${b.name}" points to "${b.target}", which is not a page in ${dir}`);
    console.error(`\n${bad.length} entr(y/ies) point to a missing page. Add the page or fix the link.`);
    return 1;
  }
  console.log(`docs examples index targets OK: ${all.length} entries in ${file} all point to existing pages`);
  return 0;
}

// The script runs only when executed directly. realpath on both sides: a symlinked path (for example a home
// directory that is a link) must still run the check, or it would pass without checking anything.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-examples-index-targets: ' + e.message); process.exitCode = 1; }
}
