#!/usr/bin/env node
// The checks a release commit must have passed before it is tagged.
//
// The list lives in .github/release-required-checks.txt (one check name per line, "#" starts a comment).
// It is the union of the checks the main and next rulesets require. Two commands:
//
//   node .github/scripts/release-required-checks.mjs lint [list-file] [workflows-dir]
//     Fails when a name in the list matches no job name in the workflows, so a renamed job breaks loudly
//     instead of making every release fail (or, worse, a name nobody can produce).
//
//   node .github/scripts/release-required-checks.mjs verify <checks.tsv> [list-file]
//     Reads the check runs of the release commit (one per line: name, status, conclusion, app slug, tab
//     separated) and fails unless every required name has a completed run with conclusion success from
//     GitHub Actions, and no run at all failed, is cancelled, or is still going. A required name is
//     matched exactly (matrix names included), and skipped or neutral never counts for a required name.
//
// Run by tag-release.yml (verify) and by the tests of this folder (lint).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LIST = path.join(here, '..', 'release-required-checks.txt');
export const DEFAULT_WORKFLOWS = path.join(here, '..', 'workflows');

// The app that must have produced a required check (GitHub Actions).
export const ACTIONS_APP = 'github-actions';
// Conclusions that do not block the release for a check that is not required.
const HARMLESS = new Set(['success', 'skipped', 'neutral']);

export function parseList(text) {
  const names = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line) names.push(line);
  }
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) throw new Error(`required check listed twice: ${n}`);
    seen.add(n);
  }
  if (names.length === 0) throw new Error('the list of required checks is empty');
  return names;
}

// Job names found in a workflow file, as written (a name can hold ${{ matrix.x }} expressions).
// A job without a name is shown in the checks UI under its id.
export function jobNames(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const out = [];
  let job = null;
  const flush = () => { if (job) out.push(job.name ?? job.id); job = null; };
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the jobs block
    const key = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (key) { flush(); job = { id: key[1], name: null }; continue; }
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (name && job && job.name === null) {
      let v = name[1];
      if (/^(["']).*\1/.test(v)) v = v.slice(1, v.lastIndexOf(v[0]));
      else v = v.replace(/\s+#.*$/, '');
      job.name = v;
    }
  }
  flush();
  return out;
}

// A job name template as a regular expression: each ${{ ... }} may be any text.
export function templateRegex(template) {
  const parts = template.split(/\$\{\{.*?\}\}/);
  return new RegExp('^' + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');
}

export function lint(required, workflowTexts) {
  const templates = workflowTexts.flatMap((t) => jobNames(t));
  const regexes = templates.map(templateRegex);
  const errors = [];
  for (const name of required) {
    if (!regexes.some((r) => r.test(name))) {
      errors.push(`required check "${name}" matches no job name in .github/workflows (was the job renamed?)`);
    }
  }
  return errors;
}

export function parseRows(tsv) {
  return tsv.split(/\r?\n/).filter((l) => l.length > 0).map((l) => {
    const [name = '', status = '', conclusion = '', app = ''] = l.split('\t');
    return { name, status, conclusion, app };
  });
}

export function verify(required, rows) {
  const errors = [];
  if (rows.length === 0) errors.push('no checks ran on this commit');
  for (const name of required) {
    const runs = rows.filter((r) => r.name === name);
    if (runs.length === 0) { errors.push(`required check missing: ${name}`); continue; }
    const good = runs.some((r) => r.status === 'completed' && r.conclusion === 'success' && r.app === ACTIONS_APP);
    if (!good) {
      const seen = runs.map((r) => `${r.status}/${r.conclusion || '-'}/${r.app || '-'}`).join(', ');
      errors.push(`required check did not succeed: ${name} (${seen})`);
    }
  }
  for (const r of rows) {
    if (r.status !== 'completed' || !HARMLESS.has(r.conclusion)) {
      errors.push(`check did not pass or did not finish: ${r.name} (${r.status}/${r.conclusion || '-'})`);
    }
  }
  return errors;
}

function readWorkflows(dir) {
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => readFileSync(path.join(dir, f), 'utf8'));
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'lint') {
      const list = rest[0] ?? DEFAULT_LIST;
      const dir = rest[1] ?? DEFAULT_WORKFLOWS;
      const required = parseList(readFileSync(list, 'utf8'));
      const errors = lint(required, readWorkflows(dir));
      if (errors.length) { for (const e of errors) console.error(`::error::${e}`); return 1; }
      console.log(`all ${required.length} required release checks match a job name`);
      return 0;
    }
    if (cmd === 'verify') {
      const [tsv, list = DEFAULT_LIST] = rest;
      if (!tsv || !existsSync(tsv)) throw new Error('usage: verify <checks.tsv> [list-file]');
      const required = parseList(readFileSync(list, 'utf8'));
      const rows = parseRows(readFileSync(tsv, 'utf8'));
      const errors = verify(required, rows);
      if (errors.length) { for (const e of errors) console.error(`::error::${e}`); return 1; }
      console.log(`all ${required.length} required checks succeeded; ${rows.length} checks ran, none failed`);
      return 0;
    }
    throw new Error('usage: release-required-checks.mjs lint [list] [workflows-dir] | verify <checks.tsv> [list]');
  } catch (e) {
    console.error(`::error::${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
