#!/usr/bin/env node
// Writes the number of Markdown pages under docs/ (not counting docs/examples/) and under docs/examples/ as a
// table to the job summary ($GITHUB_STEP_SUMMARY). Without that variable the table goes to standard output.
// Informational only: it never fails.
//
//   node .github/scripts/summarize-docs-pages.mjs [docs-dir]     default: docs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* The Markdown files under dir, sorted, as paths relative to dir with / separators. */
function listMarkdown(dir, rel = '') {
  const out = [];
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listMarkdown(dir, r));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(r);
  }
  return out;
}

/* { pages, examples }: Markdown files under docs/examples/, and every other Markdown file under docs. */
export function countPages(docsDir) {
  const all = listMarkdown(docsDir);
  const examples = all.filter((f) => f.startsWith('examples/')).length;
  return { pages: all.length - examples, examples };
}

/* The job summary section for the counts. */
export function summaryText({ pages, examples }) {
  return [
    '### Docs pages',
    '',
    '| Folder | Markdown pages |',
    '|---|---:|',
    `| docs (excluding docs/examples) | ${pages} |`,
    `| docs/examples | ${examples} |`,
    '',
  ].join('\n');
}

function main(argv) {
  const dir = argv[0] || 'docs';
  const text = summaryText(countPages(dir));
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) fs.appendFileSync(target, text + '\n');
  else process.stdout.write(text);
  return 0;
}

// realpath: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('summarize-docs-pages: ' + e.message); process.exitCode = 1; }
}
