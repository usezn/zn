#!/usr/bin/env node
// Fails when a docs/examples page that this change adds or changes has no closing section: a level-2
// heading ("## ...") whose text is one of ACCEPTED_HEADINGS, compared case-insensitively. Headings inside
// fenced code blocks do not count. docs/examples/README.md is exempt, and pages the change does not touch
// are not checked (most existing pages predate the rule).
//
//   node .github/scripts/check-docs-examples-sections.mjs --base <ref>
//
// The checked pages are the ones `git diff --diff-filter=AM --no-renames <ref> HEAD` lists under
// docs/examples/. The workflow passes HEAD^1 on pull requests and the previous tip (github.event.before) on
// pushes. Manual runs pass an empty base and a push can carry an all-zero one: with no usable base nothing can
// be attributed to a change, so the script prints a notice and exits 0 without checking any page. (Unlike
// quick-scope.sh it does not widen to every page: most existing pages predate the rule and would all fail.)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ACCEPTED_HEADINGS = [
  'Next steps', 'Where to go next', 'More', 'Related', 'See also', 'Further reading', 'Where to read more', 'Done',
];
const ACCEPTED = new Set(ACCEPTED_HEADINGS.map((h) => h.toLowerCase()));
const EXEMPT = new Set(['README.md']);

/* True when the text has a level-2 heading outside fenced code whose text is an accepted closing heading. */
export function hasClosingSection(text) {
  let fence = null;
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (h && ACCEPTED.has(h[1].trim().toLowerCase())) return true;
  }
  return false;
}

/* True for a base that names a commit to diff against: not empty and not the all-zero id of a new branch. */
export function usableBase(base) {
  const b = String(base ?? '').trim();
  return b !== '' && !/^0+$/.test(b);
}

/* The docs/examples pages (direct children, forward slashes) in a list of changed paths, README.md exempt. */
export function examplePages(paths) {
  return paths
    .filter((p) => {
      const m = p.match(/^docs\/examples\/([^/]+\.md)$/);
      return m !== null && !EXEMPT.has(m[1]);
    })
    .sort();
}

/* Returns { checked, problems: [{ file }] } for files: [{ name, text }]. */
export function checkSections(files) {
  const problems = files.filter((f) => !hasClosingSection(f.text)).map((f) => ({ file: f.name }));
  return { checked: files.length, problems };
}

/* The message for one page: names the file and the accepted headings. */
export function problemMessage(file) {
  return `${file}: no closing section. Add a level-2 heading (## ...) with one of: ${ACCEPTED_HEADINGS.join(', ')}.`;
}

function changedPaths(base) {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=AM', '--no-renames', base, 'HEAD'],
    { encoding: 'utf8' },
  );
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function main(argv) {
  const i = argv.indexOf('--base');
  if (i < 0) throw new Error('usage: check-docs-examples-sections.mjs --base <ref>');
  const base = argv[i + 1] ?? '';
  if (!usableBase(base)) {
    console.log('docs examples sections: no usable base (manual run or new branch), nothing to compare: skipped');
    return 0;
  }
  const pages = examplePages(changedPaths(base));
  const files = pages.map((name) => ({ name, text: fs.readFileSync(name, 'utf8') }));
  const { checked, problems } = checkSections(files);
  if (problems.length) {
    for (const p of problems) console.error(problemMessage(p.file));
    console.error('\nPages added or changed in this pull request end with one of those closing sections.');
    return 1;
  }
  console.log(`docs examples sections OK: ${checked} added or changed page(s) have a closing section`);
  return 0;
}

// realpath on both sides: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-examples-sections: ' + e.message); process.exitCode = 1; }
}
