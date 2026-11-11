#!/usr/bin/env node
// Fails when a link in the docs to CHANGELOG.md or SECURITY.md does not resolve. A link counts when its
// file part is a relative path of any depth whose file name is CHANGELOG.md or SECURITY.md, with or without
// an anchor. The file must exist; with an anchor, the target file must have a heading with that anchor,
// slugged the way GitHub slugs headings (a repeated heading gets -1, -2, ...). Links inside fenced code
// blocks and code spans are ignored, and so are external URLs and same-page anchors.
//
//   node .github/scripts/check-docs-changelog-security-links.mjs [repo-root]     default: .
//
// Checked files: docs/**/*.md, README.md, packages/*/README.md and changelog.d/README.md, the Markdown the
// docs checks cover. Files are read in sorted order so the output is stable.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGET_NAMES = new Set(['CHANGELOG.md', 'SECURITY.md']);

/* The lines of a Markdown text outside fenced code blocks: [{ n, text }] (n is the 1-based line number). */
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

/* The GitHub anchor of a heading text, before repeated headings are numbered. */
export function slug(heading) {
  const plain = heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, '').trim().toLowerCase();
  return plain.replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/ /g, '-');
}

/* The anchors of the headings of a Markdown text: a repeated heading gets -1, -2, ... as on GitHub. */
export function anchors(text) {
  const seen = new Map();
  const out = new Set();
  for (const { text: line } of proseLines(text)) {
    const h = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (!h) continue;
    const base = slug(h[1]);
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    out.add(k === 0 ? base : `${base}-${k}`);
  }
  return out;
}

/* The link targets of a Markdown text outside code: [{ n, target }]. */
export function linkTargets(text) {
  const out = [];
  for (const { n, text: raw } of proseLines(text)) {
    const line = raw.replace(/(`+)(?:(?!\1).)*\1/g, '');
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ n, target: m[1] });
    const def = line.match(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/);
    if (def) out.push({ n, target: def[1] });
    for (const m of line.matchAll(/<a\s[^>]*?\bhref\s*=\s*["']([^"']*)["']/gi)) out.push({ n, target: m[1] });
  }
  return out;
}

/* The file part and the anchor of a relative link target, or null when it is not a relative file link. */
export function splitTarget(target) {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) return null;
  const hash = target.indexOf('#');
  const rawFile = hash === -1 ? target : target.slice(0, hash);
  const rawAnchor = hash === -1 ? '' : target.slice(hash + 1);
  const file = decode(rawFile.split('?')[0]);
  const anchor = decode(rawAnchor);
  return { file, anchor };
}

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function walkMarkdown(root, rel) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walkMarkdown(root, r));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(r);
  }
  return out;
}

/* The Markdown files the docs checks cover, as sorted repository-relative paths. */
export function docFiles(root) {
  const files = walkMarkdown(root, 'docs');
  if (fs.existsSync(path.join(root, 'README.md'))) files.push('README.md');
  const packages = path.join(root, 'packages');
  if (fs.existsSync(packages)) {
    for (const e of fs.readdirSync(packages, { withFileTypes: true })) {
      const r = `packages/${e.name}/README.md`;
      if (e.isDirectory() && fs.existsSync(path.join(root, r))) files.push(r);
    }
  }
  if (fs.existsSync(path.join(root, 'changelog.d/README.md'))) files.push('changelog.d/README.md');
  return files.sort();
}

/* Returns { links, problems } for one file; links counts the links to CHANGELOG.md or SECURITY.md. */
export function checkFile(root, rel) {
  const problems = [];
  let links = 0;
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const { n, target } of linkTargets(text)) {
    const link = splitTarget(target);
    if (!link || !TARGET_NAMES.has(path.posix.basename(link.file))) continue;
    links++;
    const dest = path.posix.normalize(path.posix.join(path.posix.dirname(rel), link.file));
    const abs = path.join(root, dest);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      problems.push({ file: rel, line: n, target, reason: `no file ${dest}` });
      continue;
    }
    if (link.anchor && !anchors(fs.readFileSync(abs, 'utf8')).has(link.anchor)) {
      problems.push({ file: rel, line: n, target, reason: `no heading #${link.anchor} in ${dest}` });
    }
  }
  return { links, problems };
}

/* Returns { files, links, problems } for the docs under the repository root. */
export function checkRepo(root) {
  const files = docFiles(root);
  let links = 0;
  const problems = [];
  for (const f of files) {
    const r = checkFile(root, f);
    links += r.links;
    problems.push(...r.problems);
  }
  return { files: files.length, links, problems };
}

function main(argv) {
  const root = argv[0] || '.';
  const { files, links, problems } = checkRepo(root);
  if (problems.length) {
    for (const p of problems) console.error(`${p.file}:${p.line}: broken link "${p.target}": ${p.reason}`);
    console.error(`\n${problems.length} broken link(s) to CHANGELOG.md or SECURITY.md. Fix the path or the anchor.`);
    return 1;
  }
  console.log(`docs changelog/security links OK: ${links} link(s) in ${files} file(s) resolve`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-changelog-security-links: ' + e.message); process.exitCode = 1; }
}
