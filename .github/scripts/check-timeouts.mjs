#!/usr/bin/env node
// Fails when a job in .github/workflows/*.yml has no `timeout-minutes`. Without one a stuck job runs for the
// GitHub default of 360 minutes and holds a runner (and a merge queue slot) the whole time.
//
//   node .github/scripts/check-timeouts.mjs [workflow-dir]     default: .github/workflows
//
// A job that calls a reusable workflow (`uses:` at job level) is skipped: GitHub does not accept
// `timeout-minutes` there, the called workflow sets it on its own jobs. The check reads the files line by
// line (jobs are the keys indented by two spaces under `jobs:`), so it needs no YAML library; it fails on a
// workflow that has `jobs:` but no job it can read, so a change of indentation cannot switch it off.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* Returns [{ job, reason }] for the jobs of one workflow file's text that have no timeout. */
export function findMissingTimeouts(text) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  let inJobs = false;
  let hasJobsKey = false;
  let jobs = 0;
  let cur = null;
  const flush = () => {
    if (cur && !cur.timeout && !cur.reusable) problems.push({ job: cur.name, reason: 'no timeout-minutes' });
    cur = null;
  };
  for (const line of lines) {
    if (/^jobs:\s*(#.*)?$/.test(line)) { inJobs = true; hasJobsKey = true; continue; }
    if (inJobs && /^\S/.test(line) && !line.startsWith('#')) { flush(); inJobs = false; }
    if (!inJobs) continue;
    const key = line.match(/^ {2}(["']?)([A-Za-z0-9_-]+)\1:\s*(#.*)?$/);
    if (key) { flush(); jobs++; cur = { name: key[2], timeout: false, reusable: false }; continue; }
    if (!cur) continue;
    if (/^ {4}timeout-minutes:\s*\S/.test(line)) cur.timeout = true;
    if (/^ {4}uses:\s*\S/.test(line)) cur.reusable = true;
  }
  flush();
  if (hasJobsKey && jobs === 0) problems.push({ job: '(file)', reason: 'has "jobs:" but no job could be read (two-space indent expected)' });
  return problems;
}

export function checkDir(dir) {
  const out = [];
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  for (const f of files) {
    for (const p of findMissingTimeouts(fs.readFileSync(path.join(dir, f), 'utf8'))) out.push({ file: f, ...p });
  }
  return { checked: files.length, problems: out };
}

function main(argv) {
  const dir = argv[0] || '.github/workflows';
  const { checked, problems } = checkDir(dir);
  if (problems.length) {
    for (const p of problems) console.error(`${dir}/${p.file}: job "${p.job}": ${p.reason}`);
    console.error('\nAdd `timeout-minutes: <N>` to each job listed above (a little over its normal run time).');
    return 1;
  }
  console.log(`timeouts OK: every job in ${checked} workflow file(s) sets timeout-minutes`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-timeouts: ' + e.message); process.exitCode = 1; }
}
