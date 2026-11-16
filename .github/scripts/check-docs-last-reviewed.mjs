#!/usr/bin/env node
// Fails when a page that carries a review date has no "Last reviewed: YYYY-MM-DD" line, has more than one, or has
// a value that is not a real calendar date. The line is plain text on its own line, outside fenced code blocks,
// and sits under the page title.
//
//   node .github/scripts/check-docs-last-reviewed.mjs [page ...]     default: docs/compat.md docs/install-matrix.md
//
// The pages are checked in the order given. A page that cannot be read is a problem too.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PAGES = ['docs/compat.md', 'docs/install-matrix.md'];

/* The lines of a Markdown text that start with "Last reviewed:" outside fenced code blocks: [{ n, value }]. */
export function lastReviewedLines(text) {
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
    const m = line.match(/^Last reviewed:(.*)$/);
    if (m) out.push({ n: i + 1, value: m[1].trim() });
  });
  return out;
}

/* True when the value is a real calendar date written YYYY-MM-DD. */
export function isCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/* The problems of one page text, as messages (an empty list when the page is fine). */
export function checkText(text) {
  const lines = lastReviewedLines(text);
  if (lines.length === 0) return ['no "Last reviewed: YYYY-MM-DD" line under the title'];
  if (lines.length > 1) return [`${lines.length} "Last reviewed:" lines (lines ${lines.map((l) => l.n).join(', ')}); keep one`];
  const { n, value } = lines[0];
  if (!isCalendarDate(value)) return [`line ${n}: "${value}" is not a real date in the form YYYY-MM-DD`];
  return [];
}

function main(argv) {
  const pages = argv.length ? argv : PAGES;
  const problems = [];
  for (const p of pages) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      problems.push(`${p}: cannot be read (${e.code || e.message})`);
      continue;
    }
    for (const msg of checkText(text)) problems.push(`${p}: ${msg}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error('\nPut "Last reviewed: YYYY-MM-DD" once, on its own line under the page title.');
    return 1;
  }
  console.log(`last reviewed OK: ${pages.length} page(s) carry one valid date`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-last-reviewed: ' + e.message); process.exitCode = 1; }
}
