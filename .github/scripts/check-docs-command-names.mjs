#!/usr/bin/env node
// A docs page should name the command one way. The package installs two names for the same program, zn-gate and zn,
// so a page that writes `zn-gate check` in one place and `zn check` in another makes a reader wonder whether they are
// different tools. This check lists the pages that use both names in inline code.
//
//   node .github/scripts/check-docs-command-names.mjs [--strict] [file ...]
//     default: the files check-docs-tables.mjs checks (docs/, the root READMEs and packages/*/README.md)
//
// A command in inline code is a code span whose first word is `zn` or `zn-gate` and whose second word is a
// subcommand or a flag (`zn-gate check`, `zn hooks --help`). Fenced code blocks are skipped, and a span with one word
// (`zn-gate`) names no command. Without --strict the check prints the pages and exits 0 (a warning). With --strict it
// exits 1 when any page uses both names.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defaultTargets } from './check-docs-tables.mjs';

export const NAMES = ['zn', 'zn-gate'];
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const SPAN_RE = /(?<!`)`([^`\n]+)`(?!`)/g;
const SUBCOMMAND_RE = /^(?:[a-z][a-z-]*|--?[a-z][a-z-]*)$/;

/* The command name a code span names, or null: its first word is zn or zn-gate and a subcommand or flag follows. */
export function commandName(span) {
  const words = span.trim().split(/\s+/);
  if (words.length < 2 || !NAMES.includes(words[0]) || !SUBCOMMAND_RE.test(words[1])) return null;
  return words[0];
}

/* The command names used in inline code: { zn: { count, line }, 'zn-gate': { count, line } }, where line is the
 * first use (1-based). A name that is not used has no entry. */
export function usedNames(text) {
  const used = {};
  let fence = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    if (fence) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return;
    }
    const open = line.match(FENCE_OPEN_RE);
    if (open) { fence = open[1]; return; }
    for (const m of line.matchAll(SPAN_RE)) {
      const name = commandName(m[1]);
      if (!name) continue;
      if (!used[name]) used[name] = { count: 0, line: i + 1 };
      used[name].count++;
    }
  });
  return used;
}

/* Returns { checked, mixed: [{ file, used }] } for the Markdown files: mixed lists the pages that use both names. */
export function checkFiles(files) {
  const mixed = [];
  for (const f of files) {
    const used = usedNames(fs.readFileSync(f, 'utf8'));
    if (Object.keys(used).length > 1) mixed.push({ file: f, used });
  }
  return { checked: files.length, mixed };
}

function describe(used) {
  return NAMES.filter((n) => used[n])
    .map((n) => `${n} (${used[n].count} use(s), first at line ${used[n].line})`)
    .join(' and ');
}

function main(argv) {
  const strict = argv.includes('--strict');
  const args = argv.filter((a) => a !== '--strict');
  const files = args.length ? args : defaultTargets();
  if (!files.length) {
    console.error('check-docs-command-names: no Markdown files to check');
    return 1;
  }
  const { checked, mixed } = checkFiles(files);
  if (!mixed.length) {
    console.log(`docs command names OK: ${checked} file(s), each uses one command name in inline code`);
    return 0;
  }
  for (const m of mixed) console.log(`${m.file}: uses ${describe(m.used)}`);
  const summary = `${mixed.length} of ${checked} page(s) use both zn-gate and zn in inline code`;
  if (strict) {
    console.error(`\n${summary}. Write the command with one name on each page.`);
    return 1;
  }
  console.log(`\nwarning: ${summary}. Run with --strict to fail on them.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-command-names: ' + e.message); process.exitCode = 1; }
}
