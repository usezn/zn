#!/usr/bin/env node
// Fails when a workflow file in .github/workflows has no top-level `name:` or no top-level `permissions:`.
// A name keeps the Actions tab and the required-check list readable; an explicit permissions block (even an
// empty `permissions: {}`) stops a workflow from inheriting the repository default token scope.
//
//   node .github/scripts/check-workflow-header.mjs [workflow-dir]     default: .github/workflows
//
// The check reads the files line by line (top-level keys start in column 0), so it needs no YAML library.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* Returns the list of missing top-level keys ('name', 'permissions') of one workflow file's text. */
export function findMissingKeys(text) {
  const missing = [];
  for (const key of ['name', 'permissions']) {
    const re = new RegExp(`^${key}:( |$)`, 'm');
    if (!re.test(text.replace(/\r\n/g, '\n'))) missing.push(key);
  }
  return missing;
}

export function checkDir(dir) {
  const out = [];
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  for (const f of files) {
    const missing = findMissingKeys(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (missing.length) out.push({ file: f, missing });
  }
  return { checked: files.length, problems: out };
}

function main(argv) {
  const dir = argv[0] || '.github/workflows';
  const { checked, problems } = checkDir(dir);
  if (problems.length) {
    for (const p of problems) console.error(`${dir}/${p.file}: missing top-level ${p.missing.join(' and ')}`);
    console.error('\nAdd a top-level `name:` and a top-level `permissions:` block (`contents: read`, or `{}` when no job needs the token).');
    return 1;
  }
  console.log(`workflow header OK: ${checked} workflow file(s) have a top-level name and permissions`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-workflow-header: ' + e.message); process.exitCode = 1; }
}
