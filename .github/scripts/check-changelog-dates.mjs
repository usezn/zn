#!/usr/bin/env node
// Fails when a release heading in CHANGELOG.md has no ISO date (YYYY-MM-DD) or a date that is not a real
// calendar day. A release heading is a second-level heading with a version in brackets, such as
// `## [1.2.3] - 2026-01-31`. `## [Unreleased]` has no date and is skipped. Lines inside fenced code blocks are ignored.
//
//   node .github/scripts/check-changelog-dates.mjs [CHANGELOG.md]     default: CHANGELOG.md
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const RELEASE = /^## \[([^\]]+)\](.*)$/;
const ISO_DATE = /^ - (\d{4})-(\d{2})-(\d{2})\s*$/;

/* True when year y, month m (1-12) and day d form a real calendar day. */
export function isCalendarDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/* Returns { checked, problems: [{ line, heading, reason }] } for the release headings of a changelog text. */
export function checkChangelog(text) {
  const problems = [];
  let checked = 0;
  let fence = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (fence) return;
    const h = line.match(RELEASE);
    if (!h || h[1].trim().toLowerCase() === 'unreleased') return;
    checked += 1;
    const d = h[2].match(ISO_DATE);
    if (!d) {
      problems.push({ line: i + 1, heading: line, reason: 'no ISO date (YYYY-MM-DD) after the version' });
      return;
    }
    if (!isCalendarDate(Number(d[1]), Number(d[2]), Number(d[3]))) {
      problems.push({ line: i + 1, heading: line, reason: 'not a real calendar date' });
    }
  });
  return { checked, problems };
}

function main(argv) {
  const file = argv[0] || 'CHANGELOG.md';
  const { checked, problems } = checkChangelog(fs.readFileSync(file, 'utf8'));
  if (problems.length) {
    for (const p of problems) console.error(`${file}:${p.line}: ${p.reason}: ${p.heading}`);
    console.error('\nGive each release heading an ISO date, for example "## [1.2.3] - 2026-01-31".');
    return 1;
  }
  console.log(`changelog dates OK: ${checked} release heading(s) in ${file}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-changelog-dates: ' + e.message); process.exitCode = 1; }
}
