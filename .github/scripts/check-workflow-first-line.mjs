#!/usr/bin/env node
// Fails when a workflow file in .github/workflows does not start with a short comment line. The first line of
// each workflow must be a comment ("# ...") that says what the workflow is for, at most 160 characters long.
// The comment shows in the file's first screen and says what the workflow is for before its trigger is read.
//
//   node .github/scripts/check-workflow-first-line.mjs [workflow-dir]     default: .github/workflows
//
// The check reads only the first line of each file, so it needs no YAML library.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_LENGTH = 160;

/* Returns a message when the first line of a workflow text is not a short comment, or null when it is. */
export function firstLineProblem(text) {
  const first = String(text).replace(/^﻿/, '').split(/\r?\n/)[0];
  if (!/^# \S/.test(first)) return 'the first line is not a comment ("# ..." saying what the workflow is for)';
  if (first.length > MAX_LENGTH) return `the first-line comment is ${first.length} characters; keep it under ${MAX_LENGTH}`;
  return null;
}

export function checkDir(dir) {
  const problems = [];
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  for (const f of files) {
    const message = firstLineProblem(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (message) problems.push({ file: f, message });
  }
  return { checked: files.length, problems };
}

function main(argv) {
  const dir = argv[0] || '.github/workflows';
  const { checked, problems } = checkDir(dir);
  if (problems.length) {
    for (const p of problems) console.error(`${dir}/${p.file}: ${p.message}`);
    console.error('\nStart each workflow with a one-line comment that says what it is for.');
    return 1;
  }
  console.log(`workflow first line OK: ${checked} workflow file(s) start with a comment`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-workflow-first-line: ' + e.message); process.exitCode = 1; }
}
