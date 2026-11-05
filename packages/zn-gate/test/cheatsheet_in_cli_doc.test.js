'use strict';
// Every command and flag named in docs/commands-cheatsheet.md must also appear in docs/cli.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');
const cheatPath = path.join(repo, 'docs', 'commands-cheatsheet.md');
const cliPath = path.join(repo, 'docs', 'cli.md');
const present = fs.existsSync(cheatPath) && fs.existsSync(cliPath);
const opts = { skip: present ? false : 'docs not present' };

function rows() {
  const out = [];
  if (!present) return out;
  for (const line of fs.readFileSync(cheatPath, 'utf8').split('\n')) {
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    // cells: '', command, flags, example, ''
    const m = /^\[`([^`]+)`\]\(cli\.md#([^)]+)\)$/.exec(cells[1] || '');
    if (!m) continue;
    const flags = new Set();
    for (const code of (cells[2] || '').matchAll(/`([^`]+)`/g)) {
      for (const f of code[1].matchAll(/(?<![\w-])(--?[A-Za-z][\w-]*)/g)) flags.add(f[1]);
    }
    out.push({ command: m[1], anchor: m[2], flags: [...flags] });
  }
  return out;
}

const cli = present ? fs.readFileSync(cliPath, 'utf8') : '';
const all = rows();

test('the cheat sheet table is parsed', opts, () => {
  assert.ok(all.length > 30, 'found ' + all.length + ' commands');
  assert.ok(all.some((r) => r.command === 'init' && r.flags.includes('--wrap-mcp')));
});

test('every cheat sheet command has a heading in cli.md', opts, () => {
  const headings = new Set(
    [...cli.matchAll(/^#{2,4} `([^`]+)`\s*$/gm)].map((m) => m[1]),
  );
  for (const r of all) assert.ok(headings.has(r.command), 'no heading for ' + r.command);
});

test('every cheat sheet link anchor matches the cli.md heading', opts, () => {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
  const anchors = new Set([...cli.matchAll(/^#{1,6} (.+?)\s*$/gm)].map((m) => slug(m[1])));
  for (const r of all) assert.ok(anchors.has(r.anchor), 'missing anchor #' + r.anchor);
});

test('every cheat sheet flag appears in cli.md', opts, () => {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const r of all) {
    for (const f of r.flags) {
      assert.match(cli, new RegExp('(?<![\\w-])' + escape(f) + '(?![\\w-])'), r.command + ' ' + f);
    }
  }
});

test('the common settings flags appear in cli.md', opts, () => {
  const text = fs.readFileSync(cheatPath, 'utf8');
  const part = text.split(/^## Common settings/m)[1] || '';
  const flags = new Set();
  for (const code of part.matchAll(/`([^`]+)`/g)) {
    for (const f of code[1].matchAll(/(?<![\w-])(--?[A-Za-z][\w-]*)/g)) flags.add(f[1]);
  }
  assert.ok(flags.has('--local-only'));
  for (const f of flags) assert.ok(cli.includes(f), f);
});
