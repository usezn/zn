#!/usr/bin/env node
// Flags the words "easy", "easily" and "simply" in the Markdown pages under docs/. Such a word tells the reader a
// step is simple, which is not true for everyone, so the page should say what to do instead. Code is not checked:
// fenced code blocks, inline code spans, link targets and bare URLs are skipped.
//
//   node .github/scripts/check-docs-wording.mjs [docs-dir]     default: docs
//
// Exits 1 on any hit and prints each one with its file and line. Pages are listed in sorted order.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WORD = /\b(?:easy|easily|simply)\b/gi;

// Licence texts and notices quote third-party wording verbatim, so they are not checked.
const LICENCE_FILE = /^(NOTICE\.md$|LICEN[CS]E)/i;

/* The prose of one Markdown line: code spans, link targets and bare URLs blanked out, link text kept. */
export function proseOf(line) {
  return line
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ');
}

/* The hits of one Markdown text outside fenced code blocks: [{ line, word, text }], text is the source line. */
export function hitsOf(markdown) {
  const out = [];
  let fence = null;
  String(markdown).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const f = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(raw)) fence = null;
      return;
    }
    if (fence) return;
    for (const m of proseOf(raw).matchAll(WORD)) out.push({ line: i + 1, word: m[0], text: raw.trim() });
  });
  return out;
}

function listMarkdown(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMarkdown(p));
    else if (e.isFile() && e.name.endsWith('.md') && !LICENCE_FILE.test(e.name)) out.push(p);
  }
  return out;
}

/* Returns { checked, hits: [{ file, line, word, text }] } for the Markdown files under dir. */
export function checkDir(dir) {
  const files = listMarkdown(dir);
  const hits = [];
  for (const f of files) {
    const file = path.relative(dir, f).split(path.sep).join('/');
    for (const h of hitsOf(fs.readFileSync(f, 'utf8'))) hits.push({ file, ...h });
  }
  return { checked: files.length, hits };
}

function main(argv) {
  const dir = argv[0] || 'docs';
  const { checked, hits } = checkDir(dir);
  if (hits.length) {
    for (const h of hits) console.error(`${h.file}:${h.line}: "${h.word}": ${h.text.slice(0, 160)}`);
    console.error(`\n${hits.length} hit(s). Say what the reader does instead of calling a step easy or simple.`);
    return 1;
  }
  console.log(`docs wording OK: ${checked} page(s) under ${dir}, no easy, easily or simply outside code`);
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
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-wording: ' + e.message); process.exitCode = 1; }
}
