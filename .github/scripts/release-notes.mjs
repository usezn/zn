#!/usr/bin/env node
// Release notes for the GitHub Release, from the version's section of CHANGELOG.md.
//
//   node .github/scripts/release-notes.mjs --version X.Y.Z --tag vX.Y.Z --repo owner/name [--changelog CHANGELOG.md]
//
// GitHub rejects a release body longer than 125,000 characters, and a big release section can pass that
// (1.14.0 had about 161,000). When the notes are too long, the "### Fixed" list and then the "### Changed" list
// are left out (Security and Added always stay), with a link to the full section in CHANGELOG.md; if they are
// still too long, the section is cut at the last whole bullet that fits. Prints the notes on stdout and a
// warning on stderr when it shortened them.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GITHUB_LIMIT = 125000;
// Room for the footer and for characters GitHub may count differently (it counts characters, JS counts UTF-16 units).
export const LIMIT = GITHUB_LIMIT - 5000;

/* The lines of `## [version]` up to the next `## [` heading; null when there is no such section. */
export function section(changelog, version) {
  const lines = String(changelog).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n');
}

// Subsections left out, in this order, while the notes are too long: Security and Added always stay.
export const DROP_ORDER = ['Fixed', 'Changed'];

/* The section without its "### <name>" subsection (up to the next ### or the end). */
export function without(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.replace(/\s+$/, '') === `### ${name}`);
  if (start < 0) return text;
  let end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(0, start).concat(lines.slice(end)).join('\n');
}

/* Cut at the last top-level bullet (or heading) that keeps the text within `limit`. */
export function cutAtBullet(text, limit) {
  if (text.length <= limit) return text;
  const lines = text.split('\n');
  let size = 0;
  let keep = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i].length + 1;
    if (size > limit) break;
    const next = lines[i + 1];
    if (next === undefined || /^(- |#{2,3} |$)/.test(next)) keep = i + 1;
  }
  const kept = lines.slice(0, keep);
  while (kept.length && /^(#{2,3} .*|\s*)$/.test(kept[kept.length - 1])) kept.pop();   // no heading left without its list
  return kept.join('\n');
}

export function releaseNotes(changelog, { version, tag, repo, limit = LIMIT }) {
  const body = section(changelog, version);
  if (body === null || !/\S/.test(body)) throw new Error(`No section for ${version} in CHANGELOG.md`);
  const fullUrl = `https://github.com/${repo}/blob/${tag}/CHANGELOG.md`;
  const footer = [
    '',
    '---',
    '',
    `How to verify these files: [docs/verify-release.md](https://github.com/${repo}/blob/${tag}/docs/verify-release.md)`,
  ].join('\n');
  let notes = body.replace(/\s+$/, '');
  let shortened = null;
  if (notes.length + footer.length > limit) {
    const left = [];
    const lists = () => `the ${left.join(' and ')} list${left.length > 1 ? 's' : ''}`;
    const pointer = () => `\n\nThese notes are shortened to fit on GitHub${left.length ? `: ${lists()} ${left.length > 1 ? 'are' : 'is'} left out` : ''}. ` +
      `The full notes are in [CHANGELOG.md](${fullUrl}).`;
    for (const name of DROP_ORDER) {
      if (left.length && notes.length + pointer().length + footer.length <= limit) break;
      const shorter = without(notes, name).replace(/\s+$/, '');
      if (shorter !== notes) {
        notes = shorter;
        left.push(name);
      }
    }
    const parts = left.length ? [`without ${lists()}`] : [];
    if (notes.length + pointer().length + footer.length > limit) {
      notes = cutAtBullet(notes, limit - pointer().length - footer.length);
      parts.push('cut at the last bullet that fits');
    }
    shortened = parts.join(' and ');
    notes += pointer();
  }
  return { notes: notes + '\n' + footer + '\n', shortened };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function main(argv) {
  const version = arg(argv, '--version');
  const tag = arg(argv, '--tag');
  const repo = arg(argv, '--repo');
  const file = arg(argv, '--changelog') || 'CHANGELOG.md';
  if (!version || !tag || !repo) {
    process.stderr.write('usage: release-notes.mjs --version X.Y.Z --tag vX.Y.Z --repo owner/name [--changelog CHANGELOG.md]\n');
    return 2;
  }
  let res;
  try {
    res = releaseNotes(fs.readFileSync(file, 'utf8'), { version, tag, repo });
  } catch (e) {
    process.stderr.write(`::error::${e.message}\n`);
    return 1;
  }
  if (res.shortened) {
    process.stderr.write(`::warning::The release notes for ${version} are longer than GitHub accepts: published ${res.shortened}, with a link to CHANGELOG.md\n`);
  }
  process.stdout.write(res.notes);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
