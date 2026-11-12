#!/usr/bin/env node
// Fails when CHANGELOG.md has two level-2 headings for the same version, such as two "## [1.14.0]" sections.
// A repeated section shows a release twice and makes its notes ambiguous. The version is the text in the
// brackets of the heading ("Unreleased" included), compared case-sensitively. Headings inside fenced code
// blocks do not count.
//
//   node .github/scripts/check-changelog-versions.mjs [CHANGELOG.md]     default: CHANGELOG.md
//
// changelog.mjs checks only the section it is about to add; this check covers the whole file.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADING = /^## \[([^\]]+)\]/;

/* The version headings of a changelog text, in order: [{ version, line }] (line is 1-based). */
export function versionHeadings(text) {
  const out = [];
  let fence = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (fence) return;
    const m = line.match(HEADING);
    if (m) out.push({ version: m[1], line: i + 1 });
  });
  return out;
}

/* The versions that have more than one heading: [{ version, lines: [n, ...] }]. */
export function duplicateVersions(text) {
  const byVersion = new Map();
  for (const h of versionHeadings(text)) {
    if (!byVersion.has(h.version)) byVersion.set(h.version, []);
    byVersion.get(h.version).push(h.line);
  }
  return [...byVersion].filter(([, lines]) => lines.length > 1).map(([version, lines]) => ({ version, lines }));
}

function main(argv) {
  const file = argv[0] || 'CHANGELOG.md';
  const text = fs.readFileSync(file, 'utf8');
  const dups = duplicateVersions(text);
  if (dups.length) {
    for (const d of dups) {
      console.error(`${file}: version ${d.version} has ${d.lines.length} sections, on lines ${d.lines.join(', ')}. Keep one section per version.`);
    }
    return 1;
  }
  console.log(`changelog versions OK: ${versionHeadings(text).length} heading(s) in ${file}, none repeated`);
  return 0;
}

// realpath on both sides: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-changelog-versions: ' + e.message); process.exitCode = 1; }
}
