#!/usr/bin/env node
// Fails when a Markdown page under docs/ cannot be reached from docs/README.md by following links between
// pages. A page nobody links to is a page nobody finds: the index and the pages it links to are the only way a
// reader gets there.
//
//   node .github/scripts/check-docs-reachable.mjs [docs-dir]     default: docs
//
// Links are read outside fenced code blocks: `[text](target)` and `[label]: target`. A target counts when it
// resolves, from the page that holds the link, to another Markdown page under the docs folder (the `#anchor` and
// `?query` parts are dropped). Links from outside docs/ (the main README, for example) do not count.
// A page that is meant to stay out of the index goes in EXCLUDED below, each with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* Pages that are not reached from docs/README.md on purpose: relative path under docs/ -> reason. Keep it short. */
export const EXCLUDED = {};

function listMarkdown(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMarkdown(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/* The link targets of a Markdown text outside fenced code blocks, in order. */
export function linkTargets(markdown) {
  const out = [];
  let fence = null;
  for (const line of String(markdown).replace(/^﻿/, '').split(/\r?\n/)) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const noCode = line.replace(/`[^`]*`/g, '');
    for (const m of noCode.matchAll(/\]\(\s*<?([^)\s>]+)/g)) out.push(m[1]);
    const d = noCode.match(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/);
    if (d) out.push(d[1]);
  }
  return out;
}

/* The page (a path relative to docsDir, with forward slashes) that a link target names, or null when it is not
   a Markdown page under docsDir. `from` is the page holding the link, also relative to docsDir. */
export function resolveTarget(target, from) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#')) return null;
  let t = target.split('#')[0].split('?')[0];
  if (!t) return null;
  try { t = decodeURIComponent(t); } catch (_e) { /* keep as written */ }
  if (!t.endsWith('.md')) return null;
  const r = path.posix.normalize(path.posix.join(path.posix.dirname(from), t));
  return r.startsWith('..') || r.startsWith('/') ? null : r;
}

/* Returns { checked, unreachable: [page], staleExclusions: [{ page, why }] } for the Markdown files under dir. */
export function checkDir(dir, excluded = EXCLUDED) {
  const pages = new Set(listMarkdown(dir).map((f) => path.relative(dir, f).split(path.sep).join('/')));
  const root = 'README.md';
  const seen = new Set();
  if (pages.has(root)) {
    seen.add(root);
    const queue = [root];
    while (queue.length) {
      const from = queue.shift();
      for (const t of linkTargets(fs.readFileSync(path.join(dir, from), 'utf8'))) {
        const to = resolveTarget(t, from);
        if (to && pages.has(to) && !seen.has(to)) { seen.add(to); queue.push(to); }
      }
    }
  }
  const unreachable = [...pages].filter((p) => !seen.has(p) && !(p in excluded)).sort();
  const staleExclusions = [];
  for (const p of Object.keys(excluded)) {
    if (!pages.has(p)) staleExclusions.push({ page: p, why: 'the page does not exist' });
    else if (seen.has(p)) staleExclusions.push({ page: p, why: 'the page is reachable now' });
  }
  return { checked: pages.size, unreachable, staleExclusions, missingRoot: !pages.has(root) };
}

function main(argv) {
  const dir = argv[0] || 'docs';
  const { checked, unreachable, staleExclusions, missingRoot } = checkDir(dir);
  if (missingRoot) { console.error(`${dir}/README.md does not exist.`); return 1; }
  if (unreachable.length || staleExclusions.length) {
    for (const p of unreachable) console.error(`${dir}/${p}: no link path from ${dir}/README.md reaches this page.`);
    for (const s of staleExclusions) console.error(`EXCLUDED lists ${s.page}, but ${s.why}: remove it from the list.`);
    console.error('\nLink every page from docs/README.md or from a page it links to (or, if it must stay out of the index, add it to EXCLUDED with the reason).');
    return 1;
  }
  console.log(`docs reachable OK: ${checked} page(s) under ${dir}, all linked from ${dir}/README.md`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-reachable: ' + e.message); process.exitCode = 1; }
}
