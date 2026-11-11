#!/usr/bin/env node
// Fails when the command list in the Contents section of docs/cli.md does not match its command sections.
// Every command has a "### `<command>`" section, and the Contents section links each of them once. A command
// listed but without a section, or with a section but not listed, is reported by name. Subcommand headings
// ("#### `secret set`") are not compared: they belong to the section of their command.
//
//   node .github/scripts/check-docs-cli-headings.mjs [cli.md]
//
// Default: docs/cli.md. Fenced code blocks are skipped, so a "###" line inside an example is not a heading.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* The lines of a Markdown text outside fenced code blocks. */
function proseLines(text) {
  const out = [];
  let fence = false;
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { fence = !fence; continue; }
    if (!fence) out.push(line);
  }
  return out;
}

/* The commands listed in the Contents section: the code name of each "- [`name`](#anchor)" item. */
export function listedCommands(cliText) {
  const lines = proseLines(cliText);
  const start = lines.findIndex((l) => /^## Contents\s*$/.test(l));
  if (start < 0) return null;
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const item = line.match(/^\s*-\s+\[`([^`]+)`\]\(#[^)]*\)\s*$/);
    if (item) names.push(item[1].trim().split(/\s+/)[0]);
  }
  return names;
}

/* The commands with a "### `name`" section: the first word of each code-formatted third-level heading. */
export function sectionCommands(cliText) {
  const names = [];
  for (const line of proseLines(cliText)) {
    const h = line.match(/^### `([^`]+)`\s*$/);
    if (h) names.push(h[1].trim().split(/\s+/)[0]);
  }
  return names;
}

/* Returns { listed, sections, problems }; problems are messages, one per mismatched command. */
export function compareCommands(cliText, cliPath = 'docs/cli.md') {
  const listed = listedCommands(cliText);
  if (listed === null) return { listed: [], sections: [], problems: [`${cliPath}: no "## Contents" section lists the commands`] };
  const sections = sectionCommands(cliText);
  const problems = [];
  if (!listed.length) problems.push(`${cliPath}: the "## Contents" section lists no commands`);
  for (const name of listed) {
    if (!sections.includes(name)) problems.push(`${cliPath}: "${name}" is listed in the Contents section but has no "### \`${name}\`" section`);
  }
  for (const name of sections) {
    if (!listed.includes(name)) problems.push(`${cliPath}: "### \`${name}\`" has no entry in the Contents section`);
  }
  return { listed, sections, problems };
}

function main(argv) {
  const cliPath = argv[0] || 'docs/cli.md';
  const { listed, problems } = compareCommands(fs.readFileSync(cliPath, 'utf8'), cliPath);
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error('\nKeep the Contents section and the command sections of docs/cli.md in step.');
    return 1;
  }
  console.log(`docs CLI headings OK: ${listed.length} command(s) in ${cliPath} match its Contents section`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-cli-headings: ' + e.message); process.exitCode = 1; }
}
