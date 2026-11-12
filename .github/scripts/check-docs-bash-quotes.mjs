#!/usr/bin/env node
// Fails when a fenced bash, sh, shell or console code block in docs/ or README.md contains a curly quote
// (U+2018, U+2019, U+201C or U+201D). Pasted into a terminal, a curly quote is not a quote: the shell reads
// the command wrongly or refuses it, so the reader copies a broken command. Other fenced blocks (prose,
// JSON, YAML) and the text around the blocks may use curly quotes.
//
//   node .github/scripts/check-docs-bash-quotes.mjs     every Markdown page under docs/ and README.md
//
// Fence languages are compared case-insensitively. Files are listed in sorted order so the output is stable.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'console']);
const CURLY = /[‘’“”]/;

/* The lines inside fenced blocks whose language is a shell, as { line, text } (line is 1-based). */
export function shellBlockLines(md) {
  const out = [];
  let fence = null; // { ch, len, shell } while inside a fenced block
  String(md).replace(/^﻿/, '').split(/\r?\n/).forEach((text, i) => {
    if (!fence) {
      const open = text.match(/^ {0,3}(`{3,}|~{3,})\s*(.*)$/);
      if (open) {
        const lang = (open[2].trim().split(/\s+/)[0] || '').toLowerCase();
        fence = { ch: open[1][0], len: open[1].length, shell: SHELL_LANGS.has(lang) };
      }
      return;
    }
    const close = text.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === fence.ch && close[1].length >= fence.len) {
      fence = null;
      return;
    }
    if (fence.shell) out.push({ line: i + 1, text });
  });
  return out;
}

/* The curly-quote problems of one page: [{ file, line, codePoint, text }]. */
export function curlyQuoteProblems(file, md) {
  const problems = [];
  for (const { line, text } of shellBlockLines(md)) {
    const found = text.match(CURLY);
    if (found) {
      problems.push({ file, line, codePoint: 'U+' + found[0].charCodeAt(0).toString(16).toUpperCase(), text: text.trim() });
    }
  }
  return problems;
}

/* Markdown files checked by this rule under root: docs/**\/*.md and README.md, sorted, with / separators. */
export function listPages(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
  };
  if (fs.existsSync(path.join(root, 'docs'))) walk(path.join(root, 'docs'));
  if (fs.existsSync(path.join(root, 'README.md'))) out.push(path.join(root, 'README.md'));
  return out.map((p) => path.relative(root, p).split(path.sep).join('/')).sort();
}

/* Returns { checked, problems } for the pages under root. */
export function checkRoot(root) {
  const pages = listPages(root);
  const problems = [];
  for (const file of pages) {
    problems.push(...curlyQuoteProblems(file, fs.readFileSync(path.join(root, file), 'utf8')));
  }
  return { checked: pages.length, problems };
}

function main() {
  const { checked, problems } = checkRoot(process.cwd());
  if (problems.length) {
    for (const p of problems) {
      console.error(`${p.file}:${p.line}: ${p.codePoint} (curly quote) in a shell code block: ${p.text}`);
    }
    console.error('\nUse straight quotes (" or \') in bash, sh, shell and console blocks: a curly quote breaks the copied command.');
    return 1;
  }
  console.log(`docs bash quotes OK: ${checked} page(s) checked, no curly quote in a shell code block`);
  return 0;
}

// realpath on both sides: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (e) { console.error('check-docs-bash-quotes: ' + e.message); process.exitCode = 1; }
}
