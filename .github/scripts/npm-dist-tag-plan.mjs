#!/usr/bin/env node
// Which npm dist-tag a release is published under, and the check that it ended up there.
//
//   node .github/scripts/npm-dist-tag-plan.mjs plan <version> <dist-tags.json> [<plan.json>]
//     Prints "tag=<dist-tag>" and "latest_before=<version>" (for $GITHUB_OUTPUT). Fails closed.
//     With <plan.json>, also writes {version, tag, latest_before} there, to keep with the stage.
//       final release        -> latest, only if newer than the current latest; otherwise release-X.Y,
//                               so "latest" never moves back
//       X.Y.Z-rc.N           -> next        (only if newer than what next points to)
//       X.Y.Z-beta.N         -> beta        (same rule)
//       X.Y.Z-alpha.N        -> alpha       (same rule)
//
//   node .github/scripts/npm-dist-tag-plan.mjs verify <version> <tag> <latest-before> <dist-tags.json>
//     Run after publishing, on freshly read dist-tags. Fails unless <tag> points to <version> and
//     "latest" did not move backward (it is not older than <latest-before>, and, when the release was
//     published as latest, not older than <version>; a newer release that landed meanwhile is fine).
//
//   node .github/scripts/npm-dist-tag-plan.mjs staged <version> <plan.json>
//     For a re-run that finds <version> already on npm: reads the plan written when it was staged,
//     checks that it is for <version> and that its dist-tag fits the version, and prints the same two
//     lines as "plan". Fails closed on a missing, unreadable or mismatched plan.
//
// <dist-tags.json> is the output of `npm view zn-gate dist-tags --json`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PRERELEASE_TAGS = { alpha: 'alpha', beta: 'beta', rc: 'next' };

export function parse(v) {
  const m = typeof v === 'string' ? SEMVER.exec(v) : null;
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

// Semver 2.0 precedence: a prerelease is lower than its release; numeric identifiers compare as numbers
// and are lower than alphanumeric ones; a longer identifier list wins when the prefix is equal.
export function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) throw new Error(`cannot compare ${a} and ${b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p > +q ? 1 : -1;
    if (pn) return -1;
    if (qn) return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

function tagsObject(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) throw new Error('unexpected dist-tags output');
  return tags;
}

export function plan(version, tags) {
  tagsObject(tags);
  const v = parse(version);
  if (!v) throw new Error(`${version} is not a valid semver version`);
  const current = tags.latest;
  if (v.pre.length) {
    const tag = PRERELEASE_TAGS[v.pre[0]];
    if (!tag) throw new Error(`no dist-tag for prerelease type ${v.pre[0]}`);
    const at = tags[tag];
    if (at !== undefined) {
      if (!parse(at)) throw new Error(`dist-tag ${tag} points to an invalid version (${at})`);
      if (compare(version, at) <= 0) throw new Error(`${version} is not newer than ${tag} (${at})`);
    }
    if (current !== undefined && !parse(current)) throw new Error(`latest points to an invalid version (${current})`);
    return { tag, latestBefore: current ?? '' };
  }
  if (!current || !parse(current)) throw new Error(`latest is missing or invalid (${current})`);
  if (parse(current).pre.length) throw new Error(`latest points to a prerelease (${current})`);
  const tag = compare(version, current) > 0 ? 'latest' : `release-${v.major}.${v.minor}`;
  return { tag, latestBefore: current };
}

export function verify(version, tag, latestBefore, tags) {
  tagsObject(tags);
  if (!parse(version)) throw new Error(`${version} is not a valid semver version`);
  if (!tag) throw new Error('no dist-tag given');
  // "latest" may already be a newer release that landed meanwhile; any other dist-tag must be exactly this version.
  if (tag !== 'latest' && tags[tag] !== version) throw new Error(`dist-tag ${tag} points to ${tags[tag]}, expected ${version}`);
  const latest = tags.latest;
  if (latestBefore) {
    if (!latest || !parse(latest)) throw new Error(`latest is missing or invalid after publishing (${latest})`);
    if (compare(latest, latestBefore) < 0) throw new Error(`latest moved backward: ${latestBefore} -> ${latest}`);
  }
  if (tag === 'latest') {
    if (!latest || !parse(latest)) throw new Error(`latest is missing or invalid after publishing (${latest})`);
    if (compare(latest, version) < 0) throw new Error(`latest is ${latest}, expected ${version} or newer`);
  }
  return true;
}

export function stagedPlan(version, saved) {
  const v = parse(version);
  if (!v) throw new Error(`${version} is not a valid semver version`);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('the saved dist-tag plan is not an object');
  const { version: pv, tag, latest_before: lb } = saved;
  if (pv !== version) throw new Error(`the saved dist-tag plan is for ${pv}, not ${version}`);
  const allowed = v.pre.length ? [PRERELEASE_TAGS[v.pre[0]]] : ['latest', `release-${v.major}.${v.minor}`];
  if (typeof tag !== 'string' || !allowed.includes(tag)) throw new Error(`the saved dist-tag ${tag} does not fit ${version}`);
  if (typeof lb !== 'string' || (lb !== '' && !parse(lb))) throw new Error(`the saved latest-before (${lb}) is not a version`);
  if (!v.pre.length && !lb) throw new Error('the saved plan of a final release has no latest-before');
  return { tag, latestBefore: lb };
}

function main(argv) {
  const [cmd, ...a] = argv;
  try {
    if (cmd === 'plan' && (a.length === 2 || a.length === 3)) {
      const { tag, latestBefore } = plan(a[0], JSON.parse(readFileSync(a[1], 'utf8')));
      if (a[2]) writeFileSync(a[2], JSON.stringify({ version: a[0], tag, latest_before: latestBefore }) + '\n');
      console.log(`tag=${tag}`);
      console.log(`latest_before=${latestBefore}`);
      return 0;
    }
    if (cmd === 'staged' && a.length === 2) {
      const { tag, latestBefore } = stagedPlan(a[0], JSON.parse(readFileSync(a[1], 'utf8')));
      console.log(`tag=${tag}`);
      console.log(`latest_before=${latestBefore}`);
      return 0;
    }
    if (cmd === 'verify' && a.length === 4) {
      verify(a[0], a[1], a[2], JSON.parse(readFileSync(a[3], 'utf8')));
      console.log(`dist-tags are as expected: ${a[1]} -> ${a[0]}`);
      return 0;
    }
    throw new Error('usage: npm-dist-tag-plan.mjs plan <version> <dist-tags.json> [<plan.json>] | staged <version> <plan.json> | verify <version> <tag> <latest-before> <dist-tags.json>');
  } catch (e) {
    console.error(`::error::${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
