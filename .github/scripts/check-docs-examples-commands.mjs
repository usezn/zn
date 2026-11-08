#!/usr/bin/env node
// Fails when a shell block in docs/examples/*.md runs a command that docs/cli.md does not document.
// A command is `zn <sub>`, `zn-gate <sub>` or `npx [-y] zn-gate <sub>`, at the start of a line or after
// `&&`, `||`, `;`, `|` or `$(`. The subcommand is the first word that does not start with a dash. The
// documented commands are the first words of the `###` and `####` headings of docs/cli.md that are
// written as code (for example "### `secret set`" documents `secret`).
//
//   node .github/scripts/check-docs-examples-commands.mjs [cli.md] [examples-dir]
//
// Defaults: docs/cli.md and docs/examples. Files are read in sorted order so the output is stable.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'console', 'zsh', 'powershell', 'pwsh', 'ps1', 'bat', 'cmd']);

/* Fenced blocks of a Markdown text: [{ lang, lines: [{ n, text }] }] (n is the 1-based line number). */
export function fencedBlocks(text) {
  const blocks = [];
  let fence = null;
  let cur = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/);
    if (f && !fence) {
      fence = f[1];
      cur = { lang: f[2].toLowerCase(), lines: [] };
      return;
    }
    if (fence && f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
      blocks.push(cur);
      fence = null;
      cur = null;
      return;
    }
    if (fence) cur.lines.push({ n: i + 1, text: line });
  });
  return blocks;
}

/* The command words documented by the headings of cli.md: first word of each code-formatted heading. */
export function documentedCommands(cliText) {
  const out = new Set();
  let fence = false;
  for (const line of String(cliText).split(/\r?\n/)) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^#{3,4}\s+`([^`]+)`/);
    if (h) out.add(h[1].trim().split(/\s+/)[0]);
  }
  return out;
}

/* Subcommands run by one shell line: [{ program, sub }]; sub is null when no word follows. */
export function commandsInLine(line) {
  let text = line.replace(/\s+#.*$/, '').replace(/^\s*(?:\$|>|PS [^>]*>)\s+/, '');
  const found = [];
  for (const segment of text.split(/&&|\|\||;|\||\$\(/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; // VAR=value prefixes
    if (words[i] === 'npx') {
      i++;
      while (i < words.length && /^-/.test(words[i])) i++;
      const m = (words[i] || '').match(/^(zn-gate|zn)(?:@\S+)?$/);
      if (!m) continue;
      i++;
      found.push({ program: m[1], sub: nextWord(words, i) });
    } else if (words[i] === 'zn-gate' || words[i] === 'zn') {
      found.push({ program: words[i], sub: nextWord(words, i + 1) });
    }
  }
  return found;
}

function nextWord(words, i) {
  for (; i < words.length; i++) {
    if (/^-/.test(words[i])) continue;
    return words[i].replace(/^['"]|['"]$/g, '');
  }
  return null;
}

/* Returns { checked, commands, problems: [{ file, line, command }] }. */
export function checkExamples(cliText, files) {
  const documented = documentedCommands(cliText);
  const problems = [];
  let commands = 0;
  for (const { name, text } of files) {
    for (const block of fencedBlocks(text)) {
      if (!SHELL_LANGS.has(block.lang)) continue;
      let continued = false;
      for (const { n, text: line } of block.lines) {
        const skip = continued; // a continuation line holds arguments, not a new command
        continued = /\\\s*$/.test(line);
        if (skip) continue;
        for (const c of commandsInLine(line)) {
          if (c.sub === null) continue;
          commands++;
          if (!documented.has(c.sub)) problems.push({ file: name, line: n, command: `${c.program} ${c.sub}` });
        }
      }
    }
  }
  return { checked: files.length, commands, problems };
}

function main(argv) {
  const cliPath = argv[0] || 'docs/cli.md';
  const dir = argv[1] || 'docs/examples';
  const cliText = fs.readFileSync(cliPath, 'utf8');
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  const files = names.map((n) => ({ name: `${dir}/${n}`, text: fs.readFileSync(path.join(dir, n), 'utf8') }));
  const { checked, commands, problems } = checkExamples(cliText, files);
  if (problems.length) {
    for (const p of problems) console.error(`${p.file}:${p.line}: "${p.command}" has no entry in ${cliPath}`);
    console.error('\nDocument the command in docs/cli.md or fix the example.');
    return 1;
  }
  console.log(`docs examples OK: ${commands} command(s) in ${checked} page(s) under ${dir}, all documented in ${cliPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-docs-examples-commands: ' + e.message); process.exitCode = 1; }
}
