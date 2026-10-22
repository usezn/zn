#!/usr/bin/env node
// Checks that the public facts in .github/public-facts.json say the same thing in every file of this
// repository that states them: the release version (package manifests, plugin manifests, MCP Registry
// files, and every pinned zn-gate@X.Y.Z / vX.Y.Z reference in the docs), the agents with hooks, the
// license and the install command. Prints one line per difference and exits 1 if there is any.
//
//   node .github/scripts/check-public-facts.mjs [repo root]
//
// A release changes the version in public-facts.json in the same pull request as the manifests.
//
// While version.value is a pre-release (1.14.0-rc.1): the Python files ("python": true) carry the PyPI
// form (1.14.0rc1), and the pins in the docs and the {minor} of the text facts follow docsVersion, the
// last final release, because the docs keep telling people to install that one. The examples pin what
// is already published (examplesVersion): they move only after a release is on npm and PyPI.
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

/** A version in the form PyPI uses: 1.14.0-rc.1 -> 1.14.0rc1 (alpha -> a, beta -> b). Finals are unchanged. */
export function pyVersion(v) {
  const m = /^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$/.exec(String(v));
  return m ? m[1] + { alpha: 'a', beta: 'b', rc: 'rc' }[m[2]] + m[3] : v;
}

/** True for a pre-release such as 1.14.0-rc.1. */
export function isPrerelease(v) {
  return /^\d+\.\d+\.\d+-/.test(String(v));
}

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
 * With options.pluginWarnings (an array), differences in the plugin pin (pluginVersion) that only
 * show the plugin one step behind the release being prepared go there instead of into the result:
 * a release pull request is opened before the plugin can be pinned. The plugin files must still
 * agree with each other (a half-done pin fails), and any other plugin value still fails.
 */
export function check(facts, files, read, options = {}) {
  const errors = [];
  const pluginErrors = Array.isArray(options.pluginWarnings) ? options.pluginWarnings : errors;
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

  // The version a file entry states (null when its file is missing, already reported).
  const stated = (v) => {
    if (v.json) return getPath(json(v.file), v.json);
    const s = text(v.file);
    if (s === null) return null;
    const m = s.match(new RegExp(v.regex, 'm'));
    return m ? m[1] : undefined;
  };

  const version = facts.version.value;
  for (const v of facts.version.files) {
    const got = stated(v);
    if (got === null) continue;
    const want = v.python ? pyVersion(version) : version;
    if (got !== want) errors.push(`${v.file}${v.json ? ` (${v.json})` : ''}: version ${got ?? 'not found'}, public-facts.json says ${want}`);
  }

  // The examples pin a published release, checked against examplesVersion (requirements in the PyPI form).
  const examples = facts.examplesVersion;
  if (examples) {
    for (const v of examples.files || []) {
      const got = stated(v);
      if (got === null) continue;
      const want = v.python ? pyVersion(examples.value) : examples.value;
      if (got !== want) errors.push(`${v.file}${v.json ? ` (${v.json})` : ''}: version ${got ?? 'not found'}, public-facts.json examplesVersion says ${want}`);
    }
  }

  // The docs follow the release, or the last final one while the release is a pre-release.
  let docs = version;
  let docsLabel = '';
  if (isPrerelease(version)) {
    if (facts.docsVersion && facts.docsVersion.value) {
      docs = facts.docsVersion.value;
      docsLabel = ' docsVersion';
    } else {
      errors.push(`public-facts.json: version ${version} is a pre-release, so docsVersion (the last final release, which the docs pin) is required`);
    }
  }

  const allowed = new Set((facts.version.allowPins || []).map((a) => `${a.file}\0${a.pin}`));
  for (const f of pinnedFiles(files, facts.version.pinsExclude || [])) {
    const s = text(f);
    if (s === null) continue;
    for (const re of PIN_PATTERNS) {
      for (const m of s.matchAll(re)) {
        if (m[1] === docs || allowed.has(`${f}\0${m[0]}`)) continue;
        const line = s.slice(0, m.index).split('\n').length;
        errors.push(`${f}:${line}: pins ${m[0]}, public-facts.json${docsLabel} says ${docs}`);
      }
    }
  }

  // The agent plugin follows the release one step later (pinned after npm publishes it): its files and
  // the pins under its folders are checked against pluginVersion instead of the release version.
  const plugin = facts.pluginVersion;
  if (plugin) {
    const pending = pluginErrors !== errors;
    // Only the plugin lagging the release: one of the two values is the release version.
    const lag = (got) => (pending && (got === version || plugin.value === version) ? pluginErrors : errors);
    const seen = new Set();
    for (const v of plugin.files || []) {
      let got;
      if (v.json) got = getPath(json(v.file), v.json);
      else {
        const s = text(v.file);
        if (s === null) continue;
        const m = s.match(new RegExp(v.regex, 'm'));
        got = m ? m[1] : undefined;
      }
      seen.add(String(got));
      if (got !== plugin.value) lag(got).push(`${v.file}${v.json ? ` (${v.json})` : ''}: version ${got ?? 'not found'}, public-facts.json pluginVersion says ${plugin.value}`);
    }
    if (pending && seen.size > 1) errors.push(`plugin manifests disagree on the version (${[...seen].sort().join(', ')}): pin the plugin in one commit with plugins/tools/pin-release.js`);
    const prefixes = plugin.pins || [];
    for (const f of files.filter((x) => /\.(md|json)$/.test(x) && prefixes.some((p) => x.startsWith(p)) && !/package-lock\.json$/.test(x))) {
      const s = text(f);
      if (s === null) continue;
      for (const re of PIN_PATTERNS) {
        for (const m of s.matchAll(re)) {
          if (m[1] === plugin.value || allowed.has(`${f}\0${m[0]}`)) continue;
          const line = s.slice(0, m.index).split('\n').length;
          lag(m[1]).push(`${f}:${line}: pins ${m[0]}, public-facts.json pluginVersion says ${plugin.value}`);
        }
      }
    }
  }

  // {minor} in a text fact is the release line of the docs version (1.10.0 -> 1.10), so SECURITY.md follows each
  // final release and keeps the current line during a pre-release.
  const minor = docs.split('.').slice(0, 2).join('.');
  const expand = (p) => p.replaceAll('{minor}', minor);
  // Runs of spaces and tabs compare as one space, so re-padding a Markdown table does not break a fact.
  const ws = (x) => x.replace(/[ \t]+/g, ' ');
  for (const fact of facts.text || []) {
    for (const f of fact.files) {
      const s = text(f);
      if (s === null) continue;
      for (const p of (fact.must || []).map(expand)) if (!ws(s).includes(ws(p))) errors.push(`${f}: does not say "${p}" (${fact.id})`);
      for (const p of (fact.forbid || []).map(expand)) if (ws(s).includes(ws(p))) errors.push(`${f}: says "${p}" (${fact.id})`);
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
  // Set by the workflow on release pull requests only (see .github/workflows/public-facts.yml).
  const pluginWarnings = process.env.PLUGIN_PIN_PENDING === 'true' ? [] : undefined;
  const errors = check(facts, files, read, { pluginWarnings });
  for (const w of pluginWarnings || []) console.log(process.env.GITHUB_ACTIONS ? `::warning::${w.replace(/[\r\n%]/g, ' ')}` : `warning: ${w}`);
  if (pluginWarnings && pluginWarnings.length) console.log(`\n${pluginWarnings.length} plugin pin difference(s), allowed on a release pull request: pin the plugin after npm publishes the release.`);
  if (errors.length) {
    for (const e of errors) console.log(process.env.GITHUB_ACTIONS ? `::error::${e.replace(/[\r\n%]/g, ' ')}` : e);
    console.log(`\n${errors.length} difference(s) with .github/public-facts.json. Update the file or the fact, in the same pull request.`);
    process.exit(1);
  }
  const extra = [
    facts.pluginVersion ? `plugin ${facts.pluginVersion.value}` : '',
    facts.examplesVersion ? `examples ${facts.examplesVersion.value}` : '',
    isPrerelease(facts.version.value) && facts.docsVersion ? `docs ${facts.docsVersion.value}` : '',
  ].filter(Boolean).map((x) => `, ${x}`).join('');
  console.log(`public facts OK: version ${facts.version.value}${extra}, ${(facts.text || []).length + (facts.fields || []).length} other facts`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
