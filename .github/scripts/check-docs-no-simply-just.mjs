#!/usr/bin/env node
// Flags docs pages that tell the reader to "simply" or "just" run something. Two forms are flagged, outside
// fenced code blocks:
//   1. the word directly before an inline code span: "just `npm test`"
//   2. the word at the start of a sentence, of a list item or after "then", directly before an imperative verb:
//      "Just run the installer.", "- Simply type zn init", "Then just open the file."
// Not flagged: "just this step", "you have just run `zn hooks install`", "a file that was just created", "just a
// plan", and a quoted example (an odd number of double quotes before the word on the line). Inline code is masked
// for the second form, so a command written in code is not read as prose.
//
//   node .github/scripts/check-docs-no-simply-just.mjs [--strict] [docs-dir]     default: docs
//
// By default the check is warning-only: each hit is printed as a GitHub Actions warning annotation and the exit
// code is 0. With --strict each hit is printed as an error line and the exit code is 1.
// Files are listed in sorted order so the output is stable.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERBS = 'run|execute|type|enter|install|start|launch|invoke|call|use|paste|open|try';
const BEFORE_CODE = /\b(simply|just)\s+`/gi;
const IMPERATIVE = new RegExp(`(^|[.:;!?]\\s+|^\\s*(?:[-*+]|\\d+[.)])\\s+|\\bthen,?\\s+)(simply|just)\\s+(?:${VERBS})\\b`, 'gi');
const WORD = /\b(simply|just)\b/i;
export const MESSAGE = 'Avoid "simply" or "just" before a command; name the command without the filler word.';

/* The prose lines of a Markdown text, outside fenced code blocks: [{ n, text }] (n is the 1-based line number). */
export function proseLines(text) {
  const out = [];
  let fence = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (!fence) out.push({ n: i + 1, text: line });
  });
  return out;
}

/* The flagged lines of one Markdown text: [{ n, text }]. */
export function findHits(text) {
  const hits = [];
  for (const { n, text: line } of proseLines(text)) {
    const masked = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    const quoteOk = (idx) => (line.slice(0, idx).match(/"/g) || []).length % 2 === 0;
    let hit = false;
    for (const m of line.matchAll(BEFORE_CODE)) if (quoteOk(m.index)) hit = true;
    for (const m of masked.matchAll(IMPERATIVE)) {
      const idx = m.index + m[0].search(WORD);
      if (quoteOk(idx)) hit = true;
    }
    if (hit) hits.push({ n, text: line.trim() });
  }
  return hits;
}

/* The GitHub Actions warning annotation for one hit. */
export function warningLine(file, n) {
  return `::warning file=${file},line=${n}::${MESSAGE}`;
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

/* Returns { checked, hits: [{ file, n, text }] } for the Markdown files under dir. */
export function checkDir(dir) {
  const files = listMarkdown(dir);
  const hits = [];
  for (const f of files) {
    const file = f.split(path.sep).join('/');
    for (const h of findHits(fs.readFileSync(f, 'utf8'))) hits.push({ file, ...h });
  }
  return { checked: files.length, hits };
}

function main(argv) {
  const strict = argv.includes('--strict');
  const dir = argv.filter((a) => a !== '--strict')[0] || 'docs';
  const { checked, hits } = checkDir(dir);
  if (strict) {
    if (hits.length) {
      for (const h of hits) console.error(`${h.file}:${h.n}: ${h.text}`);
      console.error(`\n${hits.length} line(s) use "simply" or "just" before a command. Name the command without the filler word.`);
      return 1;
    }
    console.log(`docs simply/just OK: ${checked} page(s) under ${dir}, no filler word before a command`);
    return 0;
  }
  for (const h of hits) console.log(warningLine(h.file, h.n));
  if (hits.length) console.log(`docs simply/just: ${hits.length} warning(s) in ${checked} page(s) under ${dir} (warning only; --strict fails)`);
  else console.log(`docs simply/just OK: ${checked} page(s) under ${dir}, no filler word before a command`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-no-simply-just: ' + e.message); process.exitCode = 1; }
}
