#!/usr/bin/env node
// Changelog fragments: each pull request adds changelog.d/<name>.md instead of editing CHANGELOG.md, so sibling
// pull requests never conflict on the same lines. A release collects them into its CHANGELOG.md section.
//
//   node .github/scripts/changelog.mjs check --base <ref>     pull request check (see checkPullRequest)
//   node .github/scripts/changelog.mjs preview                print the section the next release would get
//   node .github/scripts/changelog.mjs assemble --version X.Y.Z --date YYYY-MM-DD
//                                                             write that section into CHANGELOG.md, delete the fragments
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const FRAGMENT_DIR = 'changelog.d';
const FRAGMENT_RE = /^changelog\.d\/[^/]+\.md$/;
const UNRELEASED = '## [Unreleased]';

// Paths whose change needs a changelog fragment: what ships in a package, the plugin, the MCP Registry entry or the Action.
const SHIPPED = [
  /^packages\/[^/]+\/(?:bin|lib|src)\//,
  /^packages\/[^/]+\/(?:package\.json|pyproject\.toml|server\.json)$/,
  /^src\//,
  /^plugins\/zn-gate\//,
  /^\.claude-plugin\//, /^\.cursor-plugin\//, /^\.agents\/plugins\//,
  /^skill\//,
  /^action\.ya?ml$/,
  /^Cargo\.(?:toml|lock)$/,
];
const NEVER = [/(?:^|\/)README[^/]*\.md$/i, /(?:^|\/)tests?\//, /(?:^|\/)__tests__\//, /(?:^|\/)fixtures\//, /\.test\.[cm]?[jt]s$/];

export function needsFragment(file) {
  return SHIPPED.some((re) => re.test(file)) && !NEVER.some((re) => re.test(file));
}

/* A fragment holds only `### <Section>` headings and `- ` bullets (continuation lines indented by two spaces). */
export function parseFragment(text, name = 'fragment') {
  const out = {};
  let current = null;
  const errors = [];
  for (const [i, raw] of String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n').entries()) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const h = /^### (\w+)$/.exec(line);
    if (h) {
      if (!SECTIONS.includes(h[1])) errors.push(`${name}:${i + 1}: unknown section "${h[1]}" (use ${SECTIONS.join(', ')})`);
      current = h[1];
      out[current] = out[current] || [];
    } else if (line.startsWith('- ')) {
      if (!current) errors.push(`${name}:${i + 1}: a bullet before any "### <Section>" heading`);
      else out[current].push(line);
    } else if (/^ {2}\S/.test(line) && current && out[current].length) {
      out[current][out[current].length - 1] += '\n' + line;
    } else {
      errors.push(`${name}:${i + 1}: only "### <Section>" headings and "- " bullets are allowed`);
    }
  }
  if (!errors.length && !Object.values(out).some((b) => b.length)) errors.push(`${name}: no bullets`);
  return { sections: out, errors };
}

function unreleasedBounds(changelog) {
  const start = changelog.indexOf(UNRELEASED + '\n');
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  const bodyStart = start + UNRELEASED.length + 1;
  const next = changelog.indexOf('\n## [', bodyStart);
  return { start, bodyStart, end: next < 0 ? changelog.length : next + 1 };
}

export function unreleasedText(changelog) {
  const b = unreleasedBounds(changelog);
  return changelog.slice(b.bodyStart, b.end).trim();
}

/* Merge the bullets left under [Unreleased] with the fragments, section by section, in the order of SECTIONS. */
export function buildSection(unreleased, fragments) {
  const merged = {};
  const add = (sections) => {
    for (const [s, bullets] of Object.entries(sections)) for (const b of bullets) (merged[s] = merged[s] || []).push(b);
  };
  if (unreleased) {
    const u = parseFragment(unreleased, 'CHANGELOG.md [Unreleased]');
    if (u.errors.length && !/no bullets/.test(u.errors.join())) throw new Error(u.errors.join('\n'));
    add(u.sections);
  }
  for (const f of fragments) add(f.sections);
  return SECTIONS.filter((s) => merged[s] && merged[s].length).map((s) => `### ${s}\n${merged[s].join('\n')}\n`).join('\n');
}

export function readFragments(root) {
  const dir = path.join(root, FRAGMENT_DIR);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'README.md') continue;
    const rel = FRAGMENT_DIR + '/' + e.name;
    if (!e.isFile() || !FRAGMENT_RE.test(rel)) {
      out.push({ file: rel, sections: {}, errors: [`${rel}: fragments are plain .md files directly in ${FRAGMENT_DIR}/`] });
      continue;
    }
    out.push({ file: rel, ...parseFragment(fs.readFileSync(path.join(dir, e.name), 'utf8'), rel) });
  }
  return out;
}

/* The compare links at the bottom: [Unreleased] moves to the new tag, and the new version links from the previous one. */
export function updateLinks(changelog, version) {
  const re = /^\[Unreleased\]: (\S+)\/compare\/(v[^.\s]+\.[^.\s]+\.[^.\s]+?)\.\.\.(\S+)$/m;
  const m = re.exec(changelog);
  if (!m) return changelog;
  const [line, base, prev, head] = m;
  return changelog.replace(line, `[Unreleased]: ${base}/compare/v${version}...${head}\n[${version}]: ${base}/compare/${prev}...v${version}`);
}

export function assemble(root, version, date) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error('version must look like 1.2.3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must look like 2026-01-31');
  const file = path.join(root, 'CHANGELOG.md');
  const changelog = fs.readFileSync(file, 'utf8');
  if (changelog.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const fragments = readFragments(root);
  const bad = fragments.flatMap((f) => f.errors);
  if (bad.length) throw new Error(bad.join('\n'));
  const b = unreleasedBounds(changelog);
  const section = buildSection(unreleasedText(changelog), fragments);
  if (!section) throw new Error('nothing to release: [Unreleased] and changelog.d are empty');
  const out = updateLinks(changelog.slice(0, b.bodyStart) + `\n## [${version}] - ${date}\n\n${section}\n` + changelog.slice(b.end), version);
  fs.writeFileSync(file, out);
  for (const f of fragments) fs.unlinkSync(path.join(root, f.file));
  return { fragments: fragments.length };
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/* `git diff --name-status -z`: status, then one path (two for renames and copies), each NUL-terminated. */
export function parseNameStatus(z) {
  const parts = z.split('\0');
  const out = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) { i++; out.push({ status, file: parts[i++] }); } else out.push({ status, file: parts[i++] });
  }
  return out;
}

/* Pull request rules: a valid fragment when shipped files change, and no edits to [Unreleased] in CHANGELOG.md
 * (which is what made sibling pull requests conflict). Release work (release, back-merge and plugin-pin branches,
 * and pull requests into a release branch) may edit CHANGELOG.md and needs no fragment. */
export function checkPullRequest(root, base, { skip = false, release = false } = {}) {
  const changed = parseNameStatus(git(root, ['diff', '--name-status', '-z', `${base}...HEAD`]));
  const errors = [];
  const touched = changed.filter((c) => c.file.startsWith(FRAGMENT_DIR + '/') && c.file !== FRAGMENT_DIR + '/README.md' && c.status !== 'D');
  const fragments = [];
  for (const f of touched) {
    if (!FRAGMENT_RE.test(f.file)) { errors.push(`${f.file}: fragments are plain .md files directly in ${FRAGMENT_DIR}/`); continue; }
    fragments.push(f.file);
    errors.push(...parseFragment(fs.readFileSync(path.join(root, f.file), 'utf8'), f.file).errors);
  }
  if (!release && changed.some((c) => c.file === 'CHANGELOG.md')) {
    let before = '';
    try { before = unreleasedText(git(root, ['show', `${base}:CHANGELOG.md`])); } catch (_) { /* no file on the base */ }
    if (before !== unreleasedText(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'))) {
      errors.push('CHANGELOG.md [Unreleased] was edited: add a file in changelog.d/ instead (see changelog.d/README.md)');
    }
  }
  const code = changed.filter((c) => needsFragment(c.file)).map((c) => c.file);
  if (code.length && !fragments.length && !skip && !release) {
    errors.push(`this pull request changes shipped files (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', ...' : ''}) but adds no changelog.d/ fragment; add one, or the "no-changelog" label if users see no change`);
  }
  return { errors, code, fragments };
}

function main(argv) {
  const root = process.cwd();
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'check') {
    const base = opt('--base');
    if (!base) throw new Error('check needs --base <ref>');
    const r = checkPullRequest(root, base, { skip: process.env.CHANGELOG_SKIP === '1', release: process.env.CHANGELOG_RELEASE === '1' });
    if (r.errors.length) { for (const e of r.errors) console.error('changelog: ' + e); return 1; }
    console.log(`changelog OK: ${r.fragments.length} fragment(s), ${r.code.length} shipped file(s) changed`);
    return 0;
  }
  if (cmd === 'preview') {
    const fragments = readFragments(root);
    const bad = fragments.flatMap((f) => f.errors);
    if (bad.length) { console.error(bad.join('\n')); return 1; }
    process.stdout.write(buildSection(unreleasedText(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')), fragments) || '(nothing yet)\n');
    return 0;
  }
  if (cmd === 'assemble') {
    const r = assemble(root, opt('--version'), opt('--date'));
    console.log(`CHANGELOG.md: wrote ${opt('--version')} from ${r.fragments} fragment(s) and [Unreleased]; add the release introduction by hand`);
    return 0;
  }
  console.error('usage: changelog.mjs check --base <ref> | preview | assemble --version X.Y.Z --date YYYY-MM-DD');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('changelog: ' + e.message); process.exitCode = 1; }
}
