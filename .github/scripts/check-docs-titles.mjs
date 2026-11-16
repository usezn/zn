#!/usr/bin/env node
// Fails when two pages under docs/ share the same first-level title. The title of a page is its first
// `# Heading` line outside fenced code blocks; titles are compared after trimming and lowercasing.
//
//   node .github/scripts/check-docs-titles.mjs [docs-dir]     default: docs
//
// Pages without a first-level title are ignored here (markdownlint reports those). Files are listed in
// sorted order so the output is stable.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* The first H1 of a Markdown text outside fenced code blocks, or null. */
export function firstTitle(text) {
  let fence = null;
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (h) return h[1].trim();
  }
  return null;
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

/* Returns { checked, duplicates: [{ title, files: [..] }] } for the Markdown files under dir. */
export function checkDir(dir) {
  const byTitle = new Map();
  const files = listMarkdown(dir);
  for (const f of files) {
    const title = firstTitle(fs.readFileSync(f, 'utf8'));
    if (!title) continue;
    const key = title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, { title, files: [] });
    byTitle.get(key).files.push(f.split(path.sep).join('/'));
  }
  const duplicates = [...byTitle.values()].filter((v) => v.files.length > 1);
  return { checked: files.length, duplicates };
}

function main(argv) {
  const dir = argv[0] || 'docs';
  const { checked, duplicates } = checkDir(dir);
  if (duplicates.length) {
    for (const d of duplicates) console.error(`Duplicate title "${d.title}":\n  ${d.files.join('\n  ')}`);
    console.error('\nGive each docs page its own first-level title.');
    return 1;
  }
  console.log(`docs titles OK: ${checked} page(s) under ${dir}, no shared first-level title`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-titles: ' + e.message); process.exitCode = 1; }
}
