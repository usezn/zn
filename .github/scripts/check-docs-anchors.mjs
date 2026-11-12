#!/usr/bin/env node
// Fails when two headings of one Markdown page under docs/ give the same GitHub anchor. GitHub gives the repeat
// the anchor "<slug>-1" (the third heading "<slug>-2", and so on), so a deep link to the plain slug lands on the
// first heading, and a link to the suffixed one breaks as soon as a heading above it is added or renamed.
//
//   node .github/scripts/check-docs-anchors.mjs [docs-dir]     default: docs
//
// Only ATX headings (`# Title`) are read; setext headings and HTML anchors are not. Headings inside fenced code
// blocks are ignored. Pages are listed in sorted order so the output is stable.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* The anchor GitHub gives a heading with this text, before any repeat suffix: links and code markup reduced to
   their text, lowercased, punctuation removed (letters, digits, marks, underscores and hyphens stay), and each
   space turned into a hyphen. */
export function slugOf(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/* The ATX headings of a Markdown text outside fenced code blocks: [{ line, text }], line numbers are 1-based. */
export function headingsOf(markdown) {
  const out = [];
  let fence = null;
  String(markdown).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (fence) return;
    const h = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (h) out.push({ line: i + 1, text: h[1].trim() });
  });
  return out;
}

/* The anchors that more than one heading of one page produces: [{ anchor, headings: [{ line, text }] }]. */
export function repeatedAnchors(markdown) {
  const byAnchor = new Map();
  for (const h of headingsOf(markdown)) {
    const anchor = slugOf(h.text);
    if (!anchor) continue;
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
    byAnchor.get(anchor).push(h);
  }
  return [...byAnchor]
    .filter(([, headings]) => headings.length > 1)
    .map(([anchor, headings]) => ({ anchor, headings }));
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

/* Returns { checked, problems: [{ file, anchor, headings }] } for the Markdown files under dir. */
export function checkDir(dir) {
  const files = listMarkdown(dir);
  const problems = [];
  for (const f of files) {
    const file = path.relative(dir, f).split(path.sep).join('/');
    for (const r of repeatedAnchors(fs.readFileSync(f, 'utf8'))) problems.push({ file, ...r });
  }
  return { checked: files.length, problems };
}

function main(argv) {
  const dir = argv[0] || 'docs';
  const { checked, problems } = checkDir(dir);
  if (problems.length) {
    for (const p of problems) {
      console.error(`${p.file}: anchor "#${p.anchor}" is given to ${p.headings.length} headings:`);
      for (const h of p.headings) console.error(`  line ${h.line}: ${h.text}`);
    }
    console.error(`\n${problems.length} repeated anchor(s). Give each heading of a page its own text: GitHub gives the repeat the suffix "-1", which breaks deep links.`);
    return 1;
  }
  console.log(`docs anchors OK: ${checked} page(s) under ${dir}, no heading anchor repeated`);
  return 0;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-anchors: ' + e.message); process.exitCode = 1; }
}
