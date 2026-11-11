#!/usr/bin/env node
// Fails when a line inside a fenced code block of docs/**/*.md or README.md ends with spaces or tabs.
// markdownlint's MD009 does not look inside code blocks, and trailing blanks there are copied into
// the reader's terminal or editor, so this check covers that gap. Trailing spaces outside code are MD009's job.
//
//   node .github/scripts/check-docs-code-trailing-space.mjs [repo-root]     default: the current directory
//
// Files are listed in sorted order so the output is stable. A CRLF line ending is not trailing whitespace.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* 1-based line numbers of the lines inside fenced code blocks that end with a space or a tab. */
export function trailingSpaceInCode(text) {
  const found = [];
  let fence = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence) {
      if (f) fence = f[1];
      return;
    }
    if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
      fence = null;
      return;
    }
    if (/[ \t]$/.test(line)) found.push(i + 1);
  });
  return found;
}

/* The Markdown files this check covers under root, as forward-slash paths relative to root, sorted. */
export function listTargets(root) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(r);
    }
  };
  if (fs.existsSync(path.join(root, 'docs'))) walk('docs');
  if (fs.existsSync(path.join(root, 'README.md'))) out.push('README.md');
  return out.sort();
}

/* Returns { checked, problems: [{ file, line }] } for the covered files under root. */
export function checkDir(root) {
  const files = listTargets(root);
  const problems = [];
  for (const f of files) {
    for (const line of trailingSpaceInCode(fs.readFileSync(path.join(root, f), 'utf8'))) problems.push({ file: f, line });
  }
  return { checked: files.length, problems };
}

function main(argv) {
  const root = argv[0] || '.';
  const { checked, problems } = checkDir(root);
  if (problems.length) {
    for (const p of problems) console.error(`${p.file}:${p.line}: trailing space or tab inside a code block`);
    console.error('\nRemove the trailing spaces or tabs from the lines listed above.');
    return 1;
  }
  console.log(`code block trailing space OK: no trailing space or tab in ${checked} Markdown file(s)`);
  return 0;
}

// realpath on both sides: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-code-trailing-space: ' + e.message); process.exitCode = 1; }
}
