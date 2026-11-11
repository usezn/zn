#!/usr/bin/env node
// Writes to the job summary the workflow files (.github/workflows/*.yml and *.yaml) that a change touches,
// compared with its base. The Quick checks workflow runs it on pull requests, with the base commit of the pull request.
//
//   node .github/scripts/changed-workflows-summary.mjs <base-ref>
//
// The Markdown goes to $GITHUB_STEP_SUMMARY when that is set, and to the log. The script exits 1 when git cannot
// list the changes (for example when the base is not in the clone).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/* The workflow files among the changed paths, in the order given. */
export function workflowFiles(paths) {
  return paths.filter((p) => WORKFLOW.test(p));
}

/* The Markdown of the job summary: a heading and one line per changed workflow file. */
export function summaryMarkdown(files) {
  const lines = ['### Workflows changed by this pull request', ''];
  if (files.length === 0) lines.push('No workflow file changed.');
  else for (const f of files) lines.push(`- \`${f}\``);
  return lines.join('\n') + '\n';
}

/* The paths that differ between base and HEAD (no renames: a moved file counts at both paths). */
export function changedPaths(base) {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', base, 'HEAD'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function main(argv) {
  const base = argv[0];
  if (!base) {
    console.error('usage: changed-workflows-summary.mjs <base-ref>');
    return 2;
  }
  const md = summaryMarkdown(workflowFiles(changedPaths(base)));
  process.stdout.write(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('changed-workflows-summary: ' + e.message); process.exitCode = 1; }
}
