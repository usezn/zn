#!/usr/bin/env node
// Fails when an input of the GitHub Action (the `inputs:` block of action.yml) is not named in
// docs/github-action.md. An input counts as named when its name appears in backticks there, as in the
// inputs table (`fail-on-threat`).
//
//   node .github/scripts/check-action-inputs-documented.mjs [action.yml] [docs/github-action.md]
//   defaults: action.yml and docs/github-action.md, relative to the working directory
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/* The input names under the top-level `inputs:` key of an action.yml text, in file order. */
export function actionInputs(text) {
  const names = [];
  let inInputs = false;
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    if (/^\S/.test(line)) {
      inInputs = /^inputs:\s*$/.test(line);
      continue;
    }
    if (!inInputs) continue;
    const m = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

/* The input names that the doc does not write in backticks. */
export function undocumented(names, docText) {
  return names.filter((n) => !String(docText).includes('`' + n + '`'));
}

function main(argv) {
  const action = argv[0] || 'action.yml';
  const doc = argv[1] || 'docs/github-action.md';
  const names = actionInputs(fs.readFileSync(action, 'utf8'));
  if (names.length === 0) throw new Error(`no inputs found under inputs: in ${action}`);
  const missing = undocumented(names, fs.readFileSync(doc, 'utf8'));
  if (missing.length) {
    console.error(`Inputs of ${action} that ${doc} does not name in backticks: ${missing.join(', ')}`);
    console.error('Describe each one in that page, with its name in backticks, for example `fail-on`.');
    return 1;
  }
  console.log(`action inputs documented: ${names.length} input(s) of ${action} are named in ${doc}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-action-inputs-documented: ' + e.message); process.exitCode = 1; }
}
