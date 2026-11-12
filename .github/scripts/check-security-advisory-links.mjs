#!/usr/bin/env node
// Fails when a link in SECURITY.md that points into docs/advisories/ does not resolve. The file must exist; when
// the link has an anchor (#...), the file must have a heading with that anchor, slugged the way GitHub slugs
// headings: code marks and link syntax are dropped, the text is lowercased, punctuation is removed, spaces become
// hyphens, and a repeated heading gets -1, -2, ... after its first slug.
//
// A link counts when its target, resolved from the folder of SECURITY.md, starts with docs/advisories/. A GitHub
// blob link (https://github.com/<owner>/<repo>/blob/<ref>/docs/advisories/...) counts too; its path is checked in
// this checkout, whatever the ref. Inline links [text](target) and reference definitions [label]: target are read
// outside fenced code blocks. Other external links are not checked.
//
//   node .github/scripts/check-security-advisory-links.mjs [SECURITY.md]     default: SECURITY.md
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ADVISORY_DIR = 'docs/advisories/';
const BLOB_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(docs\/advisories\/.+)$/;

/* The GitHub anchor of a heading text, without the repeat suffix. */
export function slugOf(text) {
  return text
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/* The anchors of a Markdown text: the heading slugs in order, with -1, -2 for repeats. */
export function anchorsOf(text) {
  const seen = new Map();
  const out = new Set();
  let fence = null;
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (!h) continue;
    const slug = slugOf(h[1]);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return out;
}

/* The link targets of one line of Markdown: inline links and reference definitions. */
function targetsOf(line) {
  const out = [];
  for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  const ref = line.match(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/);
  if (ref) out.push(ref[1]);
  return out;
}

/* Returns { links, problems: [{ line, target, reason }] } for the advisory links in text. Relative targets are read
   from the folder of the Markdown file: read(file) gives the text of such a file, or null when it does not exist. */
export function checkLinks(text, { read }) {
  const problems = [];
  let links = 0;
  let fence = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (fence) return;
    for (const raw of targetsOf(line)) {
      let target = raw;
      try { target = decodeURI(raw); } catch { /* keep the raw text */ }
      const blob = target.match(BLOB_URL);
      let rel;
      if (blob) rel = blob[1];
      else if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) continue;
      else rel = path.posix.normalize(target);
      const hash = rel.indexOf('#');
      const file = hash === -1 ? rel : rel.slice(0, hash);
      const anchor = hash === -1 ? '' : rel.slice(hash + 1);
      if (!file.startsWith(ADVISORY_DIR)) continue;
      links++;
      const body = read(file);
      if (body === null) {
        problems.push({ line: i + 1, target: raw, reason: `no file ${file}` });
      } else if (anchor && !anchorsOf(body).has(anchor)) {
        problems.push({ line: i + 1, target: raw, reason: `no heading with anchor "#${anchor}" in ${file}` });
      }
    }
  });
  return { links, problems };
}

function main(argv) {
  const file = argv[0] || 'SECURITY.md';
  const dir = path.dirname(file);
  const read = (rel) => {
    const p = path.join(dir, rel);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  };
  const { links, problems } = checkLinks(fs.readFileSync(file, 'utf8'), { read });
  if (problems.length) {
    for (const p of problems) console.error(`${file}:${p.line}: link "${p.target}" is broken: ${p.reason}`);
    console.error(`\n${problems.length} broken advisory link(s) in ${file}.`);
    return 1;
  }
  console.log(`security advisory links OK: ${links} link(s) to docs/advisories/ in ${file} resolve`);
  return 0;
}

// realpath: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-security-advisory-links: ' + e.message); process.exitCode = 1; }
}
