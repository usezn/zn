#!/usr/bin/env node
// Fails when a row of a Markdown table has a different number of cells than the header row of its table. Such a
// row is rendered with its cells shifted into the wrong columns or with cells dropped, and no other check reports it.
//
//   node .github/scripts/check-docs-tables.mjs [file-or-dir ...]
//     default: docs/ (recursively), README*.md at the repository root and packages/*/README.md
//
// A table is a line with a pipe followed by a delimiter row (cells of dashes with optional colons). Its body is the
// following lines that contain a pipe; the body ends at a blank line, a line without a pipe or a fence. Fenced code
// blocks are skipped. `\|` and pipes inside an inline code span are text, not cell separators. Each bad row is named
// with its file and line. The check reads the files line by line, so it needs no Markdown library.
// It also fails when a table has no delimiter row under its first row (a header without "| --- |"): no renderer shows
// such rows as a table, so the check names the first row. A line with a pipe that is not a table is not reported.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const DELIMITER_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/* The cells of one table row. Outer pipes are optional; `\|` and pipes inside an inline code span are text. */
export function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '\\|'; i += 2; continue; }
    if (c === '`') {
      let k = i;
      while (s[k] === '`') k++;
      const close = findBacktickRun(s, k, k - i);
      if (close !== -1) { cur += s.slice(i, close + (k - i)); i = close + (k - i); continue; }
      cur += s.slice(i, k);
      i = k;
      continue;
    }
    if (c === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

/* Index of the next run of exactly n backticks at or after `from`, or -1. */
function findBacktickRun(s, from, n) {
  const re = /`+/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(s))) if (m[0].length === n) return m.index;
  return -1;
}

function isDelimiterRow(line) {
  const t = line.trim();
  return t.includes('|') && DELIMITER_RE.test(t);
}

/* Returns [{ line, cells, expected }] for every row (1-based line) whose cell count differs from its header. */
export function findBadRows(text) {
  const lines = text.split(/\r?\n/);
  const bad = [];
  let fence = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fence) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      i++;
      continue;
    }
    const open = line.match(FENCE_OPEN_RE);
    if (open) { fence = open[1]; i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const width = splitCells(line).length;
      const delimWidth = splitCells(lines[i + 1]).length;
      if (delimWidth !== width) bad.push({ line: i + 2, cells: delimWidth, expected: width });
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && !FENCE_OPEN_RE.test(lines[j])) {
        const cells = splitCells(lines[j]).length;
        if (cells !== width) bad.push({ line: j + 1, cells, expected: width });
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return bad;
}

const ROW_RE = /^\s*\|/;

/* Returns [{ line }] for each run of two or more lines that start with a pipe (outside code) whose second line is not
 * a delimiter row: a table without its delimiter row, which no renderer shows as a table. A single line is not a
 * table, so a line of prose with a pipe in it is not reported. Lines that do not start with a pipe are not checked. */
export function findMissingSeparators(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let fence = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fence) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      i++;
      continue;
    }
    const open = line.match(FENCE_OPEN_RE);
    if (open) { fence = open[1]; i++; continue; }
    if (!ROW_RE.test(line)) { i++; continue; }
    let j = i + 1;
    while (j < lines.length && ROW_RE.test(lines[j]) && !FENCE_OPEN_RE.test(lines[j])) j++;
    if (j - i >= 2 && !isDelimiterRow(lines[i + 1])) out.push({ line: i + 1 });
    i = j;
  }
  return out;
}

/* Returns { checked, problems: [{ file, line, cells, expected }], missing: [{ file, line }] } for the given Markdown files. */
export function checkFiles(files) {
  const problems = [];
  const missing = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const p of findBadRows(text)) problems.push({ file: f, ...p });
    for (const m of findMissingSeparators(text)) missing.push({ file: f, ...m });
  }
  return { checked: files.length, problems, missing };
}

function posix(p) {
  return p.split(path.sep).join('/');
}

function sortedEntries(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function walkMarkdown(dir) {
  const out = [];
  for (const e of sortedEntries(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdown(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(posix(p));
  }
  return out;
}

/* The files checked when no argument is given: docs/, the root READMEs and the package READMEs (the Markdown lint globs). */
export function defaultTargets() {
  const files = [];
  if (fs.existsSync('docs')) files.push(...walkMarkdown('docs'));
  for (const e of sortedEntries('.')) if (e.isFile() && /^README.*\.md$/.test(e.name)) files.push(e.name);
  if (fs.existsSync('packages')) {
    for (const e of sortedEntries('packages')) {
      const readme = path.join('packages', e.name, 'README.md');
      if (e.isDirectory() && fs.existsSync(readme)) files.push(posix(readme));
    }
  }
  return files;
}

function main(argv) {
  const files = argv.length
    ? argv.flatMap((p) => (fs.statSync(p).isDirectory() ? walkMarkdown(p) : [p]))
    : defaultTargets();
  if (!files.length) {
    console.error('check-docs-tables: no Markdown files to check');
    return 1;
  }
  const { checked, problems, missing } = checkFiles(files);
  for (const m of missing) console.error(`${m.file}:${m.line}: table has no delimiter row under its first row (write | --- | --- | as the second line)`);
  if (problems.length || missing.length) {
    for (const p of problems) console.error(`${p.file}:${p.line}: table row has ${p.cells} cell(s), its header row has ${p.expected}`);
    console.error('\nGive every row of a table the same number of cells as its header row (write a pipe that is text as \\|).');
    return 1;
  }
  console.log(`docs tables OK: ${checked} file(s), every table row has the cell count of its header row, and every table has a delimiter row`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-tables: ' + e.message); process.exitCode = 1; }
}
