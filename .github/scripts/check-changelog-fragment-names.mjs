#!/usr/bin/env node
// Fails when a file in changelog.d/ is not a lowercase Markdown file. Every fragment is a plain .md file with a
// lowercase name (words joined by hyphens); the release tooling reads the folder as Markdown only, and on a
// case-sensitive filesystem a name that differs only in case is easy to miss. README.md is the one file the
// folder keeps that is not a fragment, so it is skipped.
//
//   node .github/scripts/check-changelog-fragment-names.mjs [fragment-dir]     default: changelog.d
//
// Directories count as entries here: a subfolder in changelog.d/ has no ".md" name and is reported.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SKIPPED = new Set(['README.md']);

/* Returns [{ name, reason }] for the names that are not lowercase .md files, README.md excepted. */
export function badNames(names) {
  const bad = [];
  for (const name of names) {
    if (SKIPPED.has(name)) continue;
    if (!name.endsWith('.md')) bad.push({ name, reason: 'does not end with .md' });
    else if (name !== name.toLowerCase()) bad.push({ name, reason: 'has upper-case letters' });
  }
  return bad;
}

/* Returns { checked, problems } for the entries of one folder. */
export function checkDir(dir) {
  const names = fs.readdirSync(dir).sort();
  return { checked: names.length, problems: badNames(names) };
}

function main(argv) {
  const dir = argv[0] || 'changelog.d';
  const { checked, problems } = checkDir(dir);
  if (problems.length) {
    for (const p of problems) console.error(`${path.posix.join(dir, p.name)}: ${p.reason}`);
    console.error('\nRename each file above to a lowercase name ending in .md (for example changelog.d/fix-init-guard.md).');
    return 1;
  }
  console.log(`changelog fragment names OK: ${checked} entries in ${dir}, all lowercase .md files (README.md excepted)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-changelog-fragment-names: ' + e.message); process.exitCode = 1; }
}
