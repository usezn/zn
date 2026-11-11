#!/usr/bin/env node
// Fails when README.md and docs/README.md do not both link each docs entry point. An entry point is a top-level
// page of docs/ (docs/<name>.md, no subfolder) that both files link today. The list is pinned in ENTRY_POINTS, so
// removing one of those links from either file fails the check; a page that only one file links is not an entry
// point and does not fail it. An entry point whose page is missing from docs/ fails too.
//
//   node .github/scripts/check-readme-entry-points.mjs [repo-root]     default: the current directory
//
// The root README links a page as docs/<name>.md; the docs index links it as <name>.md (an optional "./" and a
// "#anchor" are allowed in both). Links are read with a regular expression, so no Markdown library is needed.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENTRY_POINTS = [
  'api-quickstart.md',
  'by-agent.md',
  'check.md',
  'cli.md',
  'compat.md',
  'connect.md',
  'first-5-minutes.md',
  'github-action.md',
  'glossary.md',
  'install-matrix.md',
  'reach.md',
  'report.md',
  'rust-core.md',
  'secrets.md',
  'shield.md',
  'team.md',
  'threat-model.md',
  'troubleshooting.md',
  'uninstall.md',
  'verify-release.md',
];

function linkedPages(text, re) {
  const out = new Set();
  for (const m of String(text).replace(/^﻿/, '').matchAll(re)) out.add(m[1]);
  return out;
}

/* The top-level docs pages the root README links, as "<name>.md". */
export function linksFromRootReadme(text) {
  return linkedPages(text, /\]\((?:\.\/)?docs\/([A-Za-z0-9._-]+\.md)(?:#[^)\s]*)?\)/g);
}

/* The top-level docs pages the docs index links, as "<name>.md". */
export function linksFromDocsIndex(text) {
  return linkedPages(text, /\]\((?:\.\/)?([A-Za-z0-9._-]+\.md)(?:#[^)\s]*)?\)/g);
}

/* Returns { problems: [{ file, page, reason }] } for the repository at root. */
export function checkRepo(root) {
  const fromRoot = linksFromRootReadme(fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
  const fromIndex = linksFromDocsIndex(fs.readFileSync(path.join(root, 'docs', 'README.md'), 'utf8'));
  const problems = [];
  for (const page of ENTRY_POINTS) {
    if (!fromRoot.has(page)) problems.push({ file: 'README.md', page, reason: `does not link docs/${page}` });
    if (!fromIndex.has(page)) problems.push({ file: 'docs/README.md', page, reason: `does not link ${page}` });
    if (!fs.existsSync(path.join(root, 'docs', page))) problems.push({ file: 'docs', page, reason: `docs/${page} does not exist` });
  }
  return { problems };
}

function main(argv) {
  const root = argv[0] || '.';
  const { problems } = checkRepo(root);
  if (problems.length) {
    for (const p of problems) console.error(`${p.file}: entry point ${p.page}: ${p.reason}`);
    console.error('\nREADME.md and docs/README.md must both link every entry point listed in ENTRY_POINTS of this script.');
    return 1;
  }
  console.log(`README entry points OK: README.md and docs/README.md both link all ${ENTRY_POINTS.length} entry point(s)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-readme-entry-points: ' + e.message); process.exitCode = 1; }
}
