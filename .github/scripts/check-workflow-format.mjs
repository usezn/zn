#!/usr/bin/env node
// Fails when a workflow file in .github/workflows is not in the layout the other workflow checks read: the file
// must end with a newline, contain no tab character, and every non-blank line must be indented by a multiple of
// two spaces. The header and timeout checks read the files line by line (top-level keys in column 0, jobs two
// spaces in), so one tab or odd indent can change what they see.
//
//   node .github/scripts/check-workflow-format.mjs [workflow-dir]     default: .github/workflows
//
// Each problem is named with its file and line. The check needs no YAML library.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* Returns [{ line, reason }] (1-based lines, in line order) for the layout problems of one workflow file's text. */
export function findFormatProblems(text) {
  if (text.length === 0) return [{ line: 1, reason: 'empty file' }];
  const out = [];
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  if (endsWithNewline) lines.pop();
  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (line.includes('\t')) out.push({ line: n, reason: 'tab character (indent with spaces)' });
    if (line.trim() === '') return;
    const indent = line.match(/^ */)[0].length;
    if (indent % 2 !== 0) out.push({ line: n, reason: `indented by ${indent} spaces, not a multiple of 2` });
  });
  if (!endsWithNewline) out.push({ line: lines.length, reason: 'no newline at the end of the file' });
  return out.sort((a, b) => a.line - b.line);
}

export function checkDir(dir) {
  const out = [];
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  for (const f of files) {
    for (const p of findFormatProblems(fs.readFileSync(path.join(dir, f), 'utf8'))) out.push({ file: f, ...p });
  }
  return { checked: files.length, problems: out };
}

function main(argv) {
  const dir = argv[0] || '.github/workflows';
  const { checked, problems } = checkDir(dir);
  if (problems.length) {
    for (const p of problems) console.error(`${dir}/${p.file}:${p.line}: ${p.reason}`);
    console.error('\nWorkflow files end with a newline, use spaces only, and indent by multiples of two spaces.');
    return 1;
  }
  console.log(`workflow format OK: ${checked} workflow file(s) end with a newline, use no tabs and indent by two-space steps`);
  return 0;
}

// realpath: a symlinked checkout path would otherwise skip main() and exit 0 without checking.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-workflow-format: ' + e.message); process.exitCode = 1; }
}
