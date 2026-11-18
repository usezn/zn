#!/usr/bin/env node
// Fails a pull request that changes the files the required checks come from (the workflows, the scope scripts,
// the required-check list) unless a maintainer approved it with the "ci-change" label or a review.
//
//   node .github/scripts/trusted-ref-guard.mjs        reads PR_NUMBER, GITHUB_REPOSITORY, GITHUB_TOKEN, APPROVERS
//
// Why: a pull request runs the workflow files of its own head, so a change under test can empty a required job
// or .github/scripts/ci-scope.sh and still report green. The workflow that runs this script is started by
// pull_request_target, so GitHub takes it from the base branch and the pull request cannot change it. This script
// never checks out or runs code of the pull request: it only lists the changed file names through the API.
import { pathToFileURL } from 'node:url';

export const LABEL = 'ci-change';

/* Paths whose change needs approval. A trailing slash means "everything under it". */
export const PROTECTED = [
  '.github/workflows/',
  '.github/actions/',
  '.github/CODEOWNERS',
  '.github/release-required-checks.txt',
  '.github/scripts/ci-scope.sh',
  '.github/scripts/quick-scope.sh',
  '.github/scripts/rust-scope.sh',
  '.github/scripts/release-required-checks.mjs',
  '.github/scripts/trusted-ref-guard.mjs',
  'scripts/verify-release.sh',
];

/* Returns the changed files that are protected. */
export function protectedChanges(files) {
  return files.filter((f) => PROTECTED.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

/* True when the newest labeling event of the label was made by an approver and the label is still on the pull request.
   events: issue events (oldest first); labels: current label names. */
export function labelApproved(events, labels, approvers) {
  if (!labels.includes(LABEL)) return false;
  const last = [...events].reverse().find((e) => e.event === 'labeled' && e.label && e.label.name === LABEL);
  return Boolean(last && last.actor && approvers.includes(String(last.actor.login).toLowerCase()));
}

/* True when an approver's latest review on the current head commit is an approval. */
export function reviewApproved(reviews, headSha, approvers) {
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user || !approvers.includes(String(r.user.login).toLowerCase())) continue;
    if (r.state === 'COMMENTED') continue;
    latest.set(String(r.user.login).toLowerCase(), r);
  }
  return [...latest.values()].some((r) => r.state === 'APPROVED' && r.commit_id === headSha);
}

/* Decides: { ok, message }. */
export function decide({ files, events, labels, reviews, headSha, approvers }) {
  const touched = protectedChanges(files);
  if (touched.length === 0) return { ok: true, message: 'No protected CI file changed.' };
  if (labelApproved(events, labels, approvers)) return { ok: true, message: `Approved by label "${LABEL}": ${touched.length} protected file(s).` };
  if (reviewApproved(reviews, headSha, approvers)) return { ok: true, message: `Approved by review: ${touched.length} protected file(s).` };
  return {
    ok: false,
    message: `This pull request changes ${touched.length} file(s) that the required checks come from:\n  ${touched.join('\n  ')}\n` +
      `A maintainer (${approvers.join(', ')}) must add the "${LABEL}" label or approve the latest commit.`,
  };
}

async function api(repo, token, route) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const sep = route.includes('?') ? '&' : '?';
    const res = await fetch(`https://api.github.com/repos/${repo}${route}${sep}per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GET ${route} failed: ${res.status}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 100) return out;
  }
  throw new Error(`GET ${route}: more than 3000 rows`);
}

async function main(env) {
  const { PR_NUMBER: pr, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = env;
  const approvers = (env.APPROVERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!/^\d+$/.test(pr || '') || !repo || !token || approvers.length === 0) {
    console.error('PR_NUMBER, GITHUB_REPOSITORY, GITHUB_TOKEN and APPROVERS are required.');
    return 1;
  }
  const pull = await (await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  })).json();
  const headSha = pull.head && pull.head.sha;
  if (!headSha) throw new Error('could not read the pull request');
  const files = (await api(repo, token, `/pulls/${pr}/files`)).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  const events = await api(repo, token, `/issues/${pr}/events`);
  const reviews = await api(repo, token, `/pulls/${pr}/reviews`);
  const labels = (pull.labels || []).map((l) => l.name);
  const { ok, message } = decide({ files, events, labels, reviews, headSha, approvers });
  console[ok ? 'log' : 'error'](message);
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.env).then((code) => process.exit(code), (err) => { console.error(String(err.message || err)); process.exit(1); });
}
