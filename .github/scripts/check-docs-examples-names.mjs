#!/usr/bin/env node
// Fails when a file under docs/examples/ is not named with lowercase letters, digits and hyphens only and
// ending in .md. README.md is allowed. Every bad name is listed, so one run shows the whole list.
// Subfolders are walked too: a folder name must also use lowercase letters, digits and hyphens only.
//
//   node .github/scripts/check-docs-examples-names.mjs [examples-dir]     default: docs/examples
//
// Files are listed in sorted order so the output is stable. The check does not rename anything.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME_RE = /^[a-z0-9-]+\.md$/;
const FOLDER_RE = /^[a-z0-9-]+$/;

/* The reason a file name breaks the rule, or null when it is fine. */
export function fileProblem(name) {
  if (name === 'README.md') return null;
  if (NAME_RE.test(name)) return null;
  if (!name.endsWith('.md')) return 'does not end in .md';
  return 'may use only lowercase letters, digits and hyphens before .md';
}

/* The reason a folder name breaks the rule, or null when it is fine. */
export function folderProblem(name) {
  return FOLDER_RE.test(name) ? null : 'folder names may use only lowercase letters, digits and hyphens';
}

function walk(dir, rel, out, count) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const why = folderProblem(e.name);
      if (why) out.push({ file: relPath + '/', reason: why });
      walk(path.join(dir, e.name), relPath, out, count);
    } else {
      count.checked += 1;
      const why = fileProblem(e.name);
      if (why) out.push({ file: relPath, reason: why });
    }
  }
}

/* Returns { checked, bad: [{ file, reason }] } for the files under dir (paths relative to dir, / separators). */
export function checkDir(dir) {
  const bad = [];
  const count = { checked: 0 };
  walk(dir, '', bad, count);
  return { checked: count.checked, bad };
}

function main(argv) {
  const dir = argv[0] || path.join('docs', 'examples');
  const { checked, bad } = checkDir(dir);
  if (bad.length) {
    for (const b of bad) console.error(`Bad name ${b.file}: ${b.reason}`);
    console.error(`\n${bad.length} name(s) under ${dir} break the rule. Rename them to lowercase letters, digits and hyphens ending in .md (README.md is allowed).`);
    return 1;
  }
  console.log(`docs examples names OK: ${checked} file(s) under ${dir}`);
  return 0;
}

// The script runs only when executed directly. realpath on both sides: a symlinked path (for example a home
// directory that is a link) must still run the check, or it would pass without checking anything.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-examples-names: ' + e.message); process.exitCode = 1; }
}
