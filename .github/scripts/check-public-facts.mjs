#!/usr/bin/env node
// Checks that the public facts in .github/public-facts.json say the same thing in every file of this
// repository that states them: the release version (package manifests, plugin manifests, MCP Registry
// files, and every pinned zn-gate@X.Y.Z / vX.Y.Z reference in the docs), the agents with hooks, the
// license and the install command. Prints one line per difference and exits 1 if there is any.
//
//   node .github/scripts/check-public-facts.mjs [repo root]
//
// A release changes the version in public-facts.json in the same pull request as the manifests.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned references to a release in the docs and plugin manifests.
export const PIN_PATTERNS = [
  /zn-gate@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/g,
  /usezn\/zn@v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/g,
  /--ref v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/g,
  /\/(?:blob|tree)\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?=[/"'\s)#]|$)/g,
  // The version in prose: "installs zn-gate 1.6.0", "zn-gate **1.6.0**", "exactly version 1.6.0", "the `v1.6.0` tag".
  /zn-gate \*{0,2}(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/g,
  /exactly version (\d+\.\d+\.\d+)/g,
  /`v(\d+\.\d+\.\d+)` tag/g,
];

/** Value at a dotted path ("packages.0.version") of a parsed JSON document. */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}

/** Files whose pinned references are checked: tracked Markdown and JSON, minus the excluded prefixes. */
export function pinnedFiles(all, exclude) {
  return all.filter((f) => /\.(md|json)$/.test(f) && !exclude.some((p) => f === p || f.startsWith(p)));
}

/**
 * All differences between the facts and the files, as readable lines (empty = consistent).
 * read(file) returns the text of a file of the repository, or throws when it does not exist.
 */
export function check(facts, files, read) {
  const errors = [];
  const text = (f) => {
    try {
      return read(f);
    } catch {
      errors.push(`${f}: file not found (listed in public-facts.json)`);
      return null;
    }
  };
  const json = (f) => {
    const s = text(f);
    if (s === null) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      errors.push(`${f}: not valid JSON`);
      return undefined;
    }
  };

  const version = facts.version.value;
  for (const v of facts.version.files) {
    let got;
    if (v.json) got = getPath(json(v.file), v.json);
    else {
      const s = text(v.file);
      if (s === null) continue;
      const m = s.match(new RegExp(v.regex, 'm'));
      got = m ? m[1] : undefined;
    }
    if (got !== version) errors.push(`${v.file}${v.json ? ` (${v.json})` : ''}: version ${got ?? 'not found'}, public-facts.json says ${version}`);
  }

  const allowed = new Set((facts.version.allowPins || []).map((a) => `${a.file}\0${a.pin}`));
  for (const f of pinnedFiles(files, facts.version.pinsExclude || [])) {
    const s = text(f);
    if (s === null) continue;
    for (const re of PIN_PATTERNS) {
      for (const m of s.matchAll(re)) {
        if (m[1] === version || allowed.has(`${f}\0${m[0]}`)) continue;
        const line = s.slice(0, m.index).split('\n').length;
        errors.push(`${f}:${line}: pins ${m[0]}, public-facts.json says ${version}`);
      }
    }
  }

  for (const fact of facts.text || []) {
    for (const f of fact.files) {
      const s = text(f);
      if (s === null) continue;
      for (const p of fact.must || []) if (!s.includes(p)) errors.push(`${f}: does not say "${p}" (${fact.id})`);
      for (const p of fact.forbid || []) if (s.includes(p)) errors.push(`${f}: says "${p}" (${fact.id})`);
    }
  }

  for (const fact of facts.fields || []) {
    for (const { file, json: path, regex } of fact.files) {
      let got;
      if (path) got = getPath(json(file), path);
      else {
        const s = text(file);
        if (s === null) continue;
        const m = s.match(new RegExp(regex, 'm'));
        got = m ? m[1] : undefined;
      }
      if (got !== fact.value) errors.push(`${file}${path ? ` (${path})` : ''}: ${fact.id} is ${got ?? 'not found'}, public-facts.json says ${fact.value}`);
    }
  }
  return errors;
}

function main() {
  const root = resolve(process.argv[2] || '.');
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const facts = JSON.parse(read('.github/public-facts.json'));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const errors = check(facts, files, read);
  if (errors.length) {
    for (const e of errors) console.log(process.env.GITHUB_ACTIONS ? `::error::${e.replace(/[\r\n%]/g, ' ')}` : e);
    console.log(`\n${errors.length} difference(s) with .github/public-facts.json. Update the file or the fact, in the same pull request.`);
    process.exit(1);
  }
  console.log(`public facts OK: version ${facts.version.value}, ${(facts.text || []).length + (facts.fields || []).length} other facts`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
